import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ptyFactory } from "../src/adapters/pty/ptyAdapter.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { loadManifests, manifestFor } from "../src/heuristics/manifest.ts";
import { matchRules, ScreenWatcher, screenTail } from "../src/heuristics/screenWatcher.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { locatePtySidecar, terminalBaseEnv } from "../src/pty/locate.ts";
import { SidecarProvider } from "../src/pty/sidecar.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loom-heur-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MANIFEST = `
id = "fakecli"
name = "Fake CLI"
programs = ["fakecli"]
tail_lines = 4

[[rule]]
state = "blocked"
blocked_on = "approval"
any = ["Allow this command\\\\? \\\\(y/n\\\\)$"]

[[rule]]
state = "working"
any = ["esc to interrupt"]
ignore_case = true

[[rule]]
state = "idle"
any = ["^> ?$"]
`;

function manifests(extra: Record<string, string> = {}, enabled = ["fakecli"]) {
  const dir = tmp();
  writeFileSync(path.join(dir, "fakecli.toml"), MANIFEST);
  for (const [name, text] of Object.entries(extra)) writeFileSync(path.join(dir, name), text);
  return loadManifests(dir, enabled);
}

describe("manifests", () => {
  it("loads enabled manifests, reports bad and missing ones, and picks by program", () => {
    const { manifests: loaded, problems } = manifests({ "broken.toml": 'id = "Bad Id"\nprograms = []\n', "other.toml": 'id = "other"\nprograms = ["other"]\n[[rule]]\nstate = "idle"\nany = ["x"]\n' }, ["fakecli", "missing"]);
    expect(loaded.map((m) => m.manifest.id)).toEqual(["fakecli"]);
    expect(problems.join("\n")).toMatch(/broken\.toml is invalid/);
    expect(problems.join("\n")).toMatch(/"missing" is enabled but no manifest/);
    expect(manifestFor(loaded, { command: "/usr/local/bin/FakeCLI --flag" })?.manifest.id).toBe("fakecli");
    expect(manifestFor(loaded, { command: "C:\\Tools\\fakecli.exe" })?.manifest.id).toBe("fakecli");
    expect(manifestFor(loaded, { agent: "claude" })).toBeUndefined();
    expect(loadManifests(path.join(tmp(), "none"), ["x"]).problems[0]).toMatch(/no manifests folder/);
  });

  it("matches rules in order against the screen's last lines", () => {
    const [m] = manifests().manifests;
    expect(screenTail(["a", "", "b  ", "c", "", ""], 2)).toEqual(["b", "c"]);
    expect(matchRules(m!.rules, ["Working… (ESC to interrupt)"])).toEqual({ state: "working" });
    expect(matchRules(m!.rules, ["Working… esc to interrupt", "Allow this command? (y/n)"])).toEqual({ state: "blocked", blockedOn: "approval" });
    expect(matchRules(m!.rules, ["> "])).toEqual({ state: "idle" });
    expect(matchRules(m!.rules, ["nothing here"])).toBeUndefined();
  });

  it("reads the rendered screen, not the raw bytes", async () => {
    const [m] = manifests().manifests;
    const w = new ScreenWatcher(m!, 40, 6);
    cleanups.push(() => w.dispose());
    // A spinner line redrawn in place, then the screen cleared and a prompt drawn at row 5.
    w.queue(Buffer.from("\x1b[31mThinking\x1b[0m (esc to interrupt)\r\x1b[2K\x1b[32mWorking\x1b[0m (esc to interrupt)"));
    expect(await w.evaluate()).toEqual({ state: "working" });
    expect(await w.evaluate()).toBeUndefined();
    w.queue(Buffer.from("\x1b[2J\x1b[H\x1b[5;1H> "));
    expect(await w.evaluate()).toEqual({ state: "idle" });
  });
});

const binary = locatePtySidecar();

describe.skipIf(!binary || process.platform === "win32")("heuristic state for a real terminal session", () => {
  it("follows a hookless CLI's screen, labels it heuristic, and steps aside for pushed state", async () => {
    const bin = tmp();
    const cli = path.join(bin, "fakecli");
    writeFileSync(
      cli,
      `#!/bin/sh
printf '> '
read cmd
printf 'Working (esc to interrupt)'
sleep 1
printf '\\r\\033[2KAllow this command? (y/n) '
read answer
printf '\\r\\033[2KDone.\\n> '
read more
`,
    );
    chmodSync(cli, 0o755);
    const { manifests: loaded } = manifests();
    const provider = new SidecarProvider(() => binary!, () => terminalBaseEnv());
    cleanups.push(() => provider.close());
    const dir = tmp();
    const manager = new SessionManager({
      log: new EventLog(":memory:", "t"),
      defaultLevel: "supervised",
      maxLevel: "accept-edits",
      manifests: loaded,
      heuristicTickMs: 100,
      adapters: {
        pty: ptyFactory({
          sidecar: () => provider.get(),
          hookUrl: () => "http://127.0.0.1:1/hooks",
          sessionDir: (id) => path.join(dir, id),
          hubUrl: () => "http://127.0.0.1:1",
          launchEnv: { platform: process.platform, env: { ...process.env, SHELL: "/bin/sh" } },
        }),
      },
    });
    manager.init();
    cleanups.push(() => manager.shutdown());
    mkdirSync(path.join(dir, "work"));
    const s = await manager.create({ adapter: "pty", cwd: path.join(dir, "work"), command: cli });

    const states: string[] = [];
    manager.subscribe((e) => {
      if (e.sessionId === s.id && e.event.type === "session.state" && e.event.provenance === "heuristic") states.push(e.event.blockedOn ? `${e.event.state}:${e.event.blockedOn}` : e.event.state);
    });
    const until = async (want: string) => {
      const end = Date.now() + 10_000;
      while (!states.includes(want)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${want}; saw ${states.join(", ")}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    manager.terminalWrite(s.id, Buffer.from("go\r"));
    await until("working");
    await until("blocked:approval");
    expect(manager.get(s.id)).toMatchObject({ state: "blocked", blockedOn: "approval", stateProvenance: "heuristic" });
    manager.terminalWrite(s.id, Buffer.from("y\r"));
    await until("idle");

    // A pushed state (as hooks would send) switches heuristics off for this session.
    manager.heuristics.sawPushed(s.id);
    const count = states.length;
    manager.terminalWrite(s.id, Buffer.from("x\r"));
    await new Promise((r) => setTimeout(r, 400));
    expect(states.length).toBe(count);
  }, 30_000);
});

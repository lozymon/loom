import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ptyFactory } from "../src/adapters/pty/ptyAdapter.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { locatePtySidecar, terminalBaseEnv } from "../src/pty/locate.ts";
import { PtySidecar, SidecarProvider } from "../src/pty/sidecar.ts";
import { hashToken } from "../src/auth.ts";
import { type HubServer, startHubServer } from "../src/server/wsServer.ts";
import { fakeFactory } from "./support/fakeAdapter.ts";
import { PolicyStore } from "../src/policy/store.ts";

const binary = locatePtySidecar();
const posix = process.platform !== "win32";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const shell = posix ? { program: "/bin/sh", flag: "-c" } : { program: "cmd.exe", flag: "/c" };

describe.skipIf(!binary)("PtySidecar (real loom-pty)", () => {
  let sidecar: PtySidecar;
  afterAll(() => sidecar?.close());

  async function run(script: string, opts: { cols?: number; rows?: number; env?: Record<string, string> } = {}) {
    sidecar ??= await PtySidecar.start(binary!, terminalBaseEnv());
    const out: Buffer[] = [];
    let frames = 0;
    let code: number | undefined;
    const { id, pid } = await sidecar.spawn(
      { program: shell.program, args: [shell.flag, script], cols: opts.cols ?? 80, rows: opts.rows ?? 24, env: opts.env ?? {} },
      { output: (b) => { out.push(b); frames++; }, exit: (c) => { code = c; } },
    );
    return {
      id,
      pid,
      text: () => Buffer.concat(out).toString("utf8"),
      bytes: () => Buffer.concat(out).length,
      frames: () => frames,
      code: () => code,
      done: () => until(() => code !== undefined, `exit of ${script}`, 30_000),
    };
  }

  it.skipIf(!posix)("streams output, passes the environment, and reports the exit code after the last output", async () => {
    const t = await run('printf "hello %s" "$LOOM_T"; exit 7', { env: { LOOM_T: "there" } });
    await t.done();
    expect(t.text()).toContain("hello there");
    expect(t.code()).toBe(7);
  });

  it.skipIf(!posix)("sets the terminal size and applies resizes", async () => {
    const t = await run("stty size; read x; stty size", { cols: 91, rows: 17 });
    await until(() => t.text().includes("17 91"), "initial size");
    sidecar.resize(t.id, 120, 40);
    sidecar.write(t.id, Buffer.from("\r"));
    await t.done();
    expect(t.text()).toContain("40 120");
  });

  it.skipIf(!posix)("round-trips input, including multibyte text", async () => {
    const t = await run("read line; printf 'got:%s' \"$line\"");
    sidecar.write(t.id, Buffer.from("héllo 世界 🎉\r", "utf8"));
    await t.done();
    expect(t.text()).toContain("got:héllo 世界 🎉");
  });

  it.skipIf(!posix)("kills a running process", async () => {
    const t = await run("sleep 30");
    sidecar.kill(t.id);
    await t.done();
    expect(t.code()).not.toBe(0);
  });

  it.skipIf(!posix)("delivers a 5 MB flood completely, in a bounded number of frames", async () => {
    const t = await run("head -c 5000000 /dev/zero | tr '\\0' 'x'");
    await t.done();
    // Every payload byte arrives; the terminal may add a few control bytes of its own.
    expect(t.text().split("").filter((c) => c === "x").length).toBe(5_000_000);
    expect(t.bytes()).toBeLessThan(5_000_100);
    // 64 KB frames: about 77 minimum; far fewer than one frame per 8 KB read.
    expect(t.frames()).toBeLessThan(400);
  }, 60_000);

  it.skipIf(!posix)("kills its children when the hub side closes", async () => {
    const own = await PtySidecar.start(binary!, terminalBaseEnv());
    let exited = false;
    const { pid } = await own.spawn(
      { program: "/bin/sh", args: ["-c", "sleep 60"], cols: 80, rows: 24, env: {} },
      { output: () => {}, exit: () => { exited = true; } },
    );
    expect(pid).toBeGreaterThan(0);
    own.close();
    await until(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, "child to be gone");
    void exited;
  });

  it("reports a program that cannot start", async () => {
    sidecar ??= await PtySidecar.start(binary!, terminalBaseEnv());
    await expect(
      sidecar.spawn({ program: "/definitely/not/here", args: [], cols: 80, rows: 24, env: {} }, { output: () => {}, exit: () => {} }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!binary || !posix)("terminal sessions through the hub", () => {
  function hub(extra: { claudeProgram?: string; log?: EventLog } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-term-"));
    const policy = new PolicyStore({ hubFile: path.join(dir, "hub-policy.json"), trustFile: path.join(dir, "trust.json") });
    const provider = new SidecarProvider(() => binary, () => terminalBaseEnv());
    const fake = fakeFactory();
    let port = 0;
    const log = extra.log ?? new EventLog(":memory:", "t");
    const manager = new SessionManager({
      log,
      defaultLevel: "supervised",
      maxLevel: "accept-edits",
      policy,
      adapters: {
        "claude-sdk": fake.factory,
        pty: ptyFactory({
          sidecar: () => provider.get(),
          hookUrl: (id) => `http://127.0.0.1:${port}/hooks/${id}`,
          sessionDir: (id) => path.join(dir, id),
          hubUrl: () => `http://127.0.0.1:${port}`,
          launchEnv: { platform: process.platform, env: { ...process.env, SHELL: "/bin/sh" } },
          ...(extra.claudeProgram ? { claudeProgram: extra.claudeProgram } : {}),
        }),
      },
    });
    manager.init();
    const setPort = (p: number) => (port = p);
    cleanups.push(async () => {
      await manager.shutdown();
      await provider.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { manager, fake, dir, setPort, log, provider, policy };
  }

  function screen(manager: SessionManager, id: string) {
    const chunks: Buffer[] = [];
    const attached = manager.terminalAttach(id, (_o, b) => chunks.push(b));
    chunks.push(attached.data);
    cleanups.push(attached.detach);
    return () => Buffer.concat(chunks).toString("utf8");
  }

  it("runs a command, takes input, ends with its exit code, restarts, and stops", async () => {
    const { manager } = hub();
    const s = await manager.create({ adapter: "pty", cwd: os.tmpdir(), command: "printf ready; read line; printf 'got:%s' \"$line\"; exit 3" });
    expect(manager.get(s.id)).toMatchObject({ live: true, command: expect.stringContaining("printf ready") });
    const text = screen(manager, s.id);
    await until(() => text().includes("ready"), "ready");

    manager.terminalWrite(s.id, Buffer.from("hi\r"));
    await until(() => manager.get(s.id).state === "error", "exit");
    expect(text()).toContain("got:hi");
    expect(manager.get(s.id)).toMatchObject({ exitCode: 3, live: false });
    await expect(manager.send(s.id, "x")).rejects.toMatchObject({ code: "invalid" });

    await manager.restart(s.id);
    await until(() => text().split("ready").length >= 3, "second run");
    expect(text()).toContain("restarted");
    await manager.stop(s.id);
    expect(manager.get(s.id)).toMatchObject({ state: "done", live: false });
  });

  it("gives a late attacher the earlier output with a consistent offset", async () => {
    const { manager } = hub();
    const s = await manager.create({ adapter: "pty", cwd: os.tmpdir(), command: "printf 'first-line'; sleep 30" });
    const early = screen(manager, s.id);
    await until(() => early().includes("first-line"), "output");
    const late = manager.terminalAttach(s.id, () => {});
    cleanups.push(late.detach);
    expect(late.data.toString()).toContain("first-line");
    expect(late.offset).toBe(0);
    expect(late.live).toBe(true);
  });

  it("ends running terminals when the hub restarts", async () => {
    const log = new EventLog(":memory:", "t");
    const first = hub({ log });
    const s = await first.manager.create({ adapter: "pty", cwd: os.tmpdir(), command: "sleep 30" });
    const second = new SessionManager({ log, defaultLevel: "supervised", maxLevel: "accept-edits", adapters: {} });
    second.init();
    expect(second.get(s.id)).toMatchObject({ state: "done", live: false });
  });

  it("continues a chat session in Claude's terminal, with hooks driving state and approvals", async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "loom-fake-claude-"));
    cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
    const fakeClaude = path.join(bin, "claude");
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf 'TOKEN=%s\\n' "$LOOM_HOOK_TOKEN"\nprintf 'ARGS=%s\\n' "$*"\nexec cat\n`);
    chmodSync(fakeClaude, 0o755);

    const { manager, setPort, dir } = hub({ claudeProgram: fakeClaude });
    writeFileSync(path.join(dir, "hub-policy.json"), JSON.stringify({ deny: ["Bash(curl *)"] }));
    const server: HubServer = await startHubServer({
      manager,
      hub: { id: "h", name: "t", version: "0", platform: "linux", maxLevel: "accept-edits", defaultLevel: "supervised", stewardModel: false },
      tokenHash: hashToken("x"),
      hosts: ["127.0.0.1"],
      port: 0,
    });
    cleanups.push(() => server.close());
    setPort(server.port);

    const chat = await manager.create({ adapter: "claude-sdk", cwd: os.tmpdir(), prompt: "hello" });
    const term = await manager.openTerminal(chat.id);
    expect(term).toMatchObject({ adapter: "pty", agent: "claude", linkedSessionId: chat.id, engineSessionId: `engine-${chat.id}` });
    expect(manager.get(chat.id).live).toBe(false);

    const text = screen(manager, term.id);
    await until(() => /TOKEN=\S+/.test(text()) && text().includes("ARGS="), "fake claude to start");
    const token = /TOKEN=(\S+)/.exec(text())![1]!;
    const args = /ARGS=(.*)/.exec(text())![1]!;
    expect(args).toContain(`--resume engine-${chat.id}`);
    expect(args).toContain("--permission-mode default");
    const settingsFile = /--settings (\S+)/.exec(args)![1]!;
    expect(existsSync(settingsFile)).toBe(true);
    expect(readFileSync(settingsFile, "utf8")).toContain(`/hooks/${term.id}`);
    expect(readFileSync(settingsFile, "utf8")).not.toContain(token);

    await expect(manager.send(chat.id, "again")).rejects.toThrow(/open in terminal session/);
    expect((await manager.openTerminal(chat.id)).id).toBe(term.id);

    const post = (body: object, auth = token, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${server.port}/hooks/${term.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

    expect((await post({ hook_event_name: "SessionStart", session_id: "uuid-tui" }, "wrong")).status).toBe(401);
    expect((await post({ hook_event_name: "SessionStart", session_id: "uuid-tui", model: "claude-opus-5" })).status).toBe(200);
    expect(manager.get(term.id)).toMatchObject({ engineSessionId: "uuid-tui", model: "claude-opus-5", state: "idle", stateProvenance: "pushed" });

    await post({ hook_event_name: "UserPromptSubmit", session_id: "uuid-tui", prompt: "run the tests" });
    expect(manager.get(term.id)).toMatchObject({ state: "working", subtitle: "run the tests" });

    const pending = post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } });
    await until(() => manager.approvals().length === 1, "approval");
    expect(manager.get(term.id)).toMatchObject({ state: "blocked", blockedOn: "approval" });
    manager.decide(manager.approvals()[0]!.id, { type: "deny", message: "not now" });
    const res = await pending;
    expect(await res.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } } });

    const ruled = await post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "curl https://example.com" } });
    expect(await ruled.json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", message: expect.stringContaining("Bash(curl *)") } } });
    expect(manager.approvals()).toEqual([]);

    const abort = new AbortController();
    const dropped = post({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, token, abort.signal);
    await until(() => manager.approvals().length === 1, "second approval");
    abort.abort();
    await dropped.catch(() => undefined);
    await until(() => manager.approvals().length === 0, "cancelled approval");

    await manager.stop(term.id);
    await expect(manager.send(chat.id, "back in chat")).resolves.toBeUndefined();
  }, 30_000);
});

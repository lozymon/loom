import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { hashToken } from "../src/auth.ts";
import { BoardService } from "../src/board/boardService.ts";
import type { Actor } from "../src/control/actor.ts";
import { Blackboard } from "../src/control/blackboard.ts";
import { authorize, canUse } from "../src/control/capabilities.ts";
import { SessionTokens } from "../src/control/tokens.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { inProcessApi } from "../src/loom/inProcess.ts";
import { loomTools, runTool } from "../src/loom/tools.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { startHubServer } from "../src/server/wsServer.ts";
import { Steward } from "../src/steward/steward.ts";
import { fakeFactory } from "./support/fakeAdapter.ts";
import { flush } from "./support/hub.ts";

const run = promisify(execFile);
const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function hub(opts: { stewardOn?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loom-cockpit-"));
  dirs.push(dir);
  const fake = fakeFactory();
  const manager = new SessionManager({
    log: new EventLog(":memory:", "t"),
    defaultLevel: "supervised",
    maxLevel: "assisted",
    adapters: { "claude-sdk": fake.factory },
    cockpitDir: path.join(dir, "cockpit"),
    dataDir: dir,
    ...(opts.stewardOn
      ? { steward: new Steward({ enabled: true, model: "m", mode: "recommend", minConfidence: 0.9, maxDecisionsPerHour: 5, maxDailyUsd: 1 }, { review: async () => ({ decision: "escalate", confidence: 0.5, risk: "low", reason: "", model: "m", costUsd: 0, durationMs: 0 }) }) }
      : {}),
  });
  manager.init();
  const boards = new BoardService({ manager });
  const as = (actor: Actor) => inProcessApi(manager, () => boards, actor);
  return { dir, manager, fake, boards, as };
}

const bash = (command: string) => ({ kind: "permission" as const, summary: `Run: ${command}`, toolName: "Bash", input: { command }, canAlwaysAllow: false });

describe("capabilities", () => {
  it("gives sessions coordination, the Cockpit control, and neither policy or terminals", () => {
    expect(canUse("session", "notes.set")).toBe(true);
    expect(canUse("session", "session.create")).toBe(false);
    expect(canUse("cockpit", "session.create")).toBe(true);
    for (const cmd of ["policy.save", "policy.trust", "approval.override", "terminal.write", "events.subscribe", "session.unarchive"] as const) {
      expect(canUse("cockpit", cmd)).toBe(false);
    }
    expect(() => authorize({ kind: "session", sessionId: "s", role: "session" }, { cmd: "approval.decide", approvalId: "a", decision: { type: "allow" } })).toThrow(/cannot use approval.decide/);
    expect(() => authorize({ kind: "human" }, { cmd: "policy.trust", cwd: "/", allowHash: "x" })).not.toThrow();
  });

  it("issues one live token per session and revokes it", () => {
    const tokens = new SessionTokens();
    const first = tokens.issue("s1", "session");
    const second = tokens.issue("s1", "cockpit");
    expect(tokens.verify(first)).toBeUndefined();
    expect(tokens.verify(second)).toEqual({ sessionId: "s1", role: "cockpit" });
    tokens.revoke("s1");
    expect(tokens.verify(second)).toBeUndefined();
    expect(tokens.verify("not-a-token")).toBeUndefined();
  });

  it("keeps claims advisory and exclusive", () => {
    const bb = new Blackboard();
    bb.claim("/tmp", "src/a.ts", "s1", "Faye", "refactor");
    expect(() => bb.claim("/tmp", "src/a.ts", "s2", "Cleo")).toThrow(/claimed by Faye \(refactor\)/);
    expect(() => bb.release("/tmp", "src/a.ts", "s2", false)).toThrow(/with force/);
    bb.releaseAll("s1");
    expect(bb.listClaims("/tmp")).toEqual([]);
  });
});

describe("the Cockpit and sessions through the router", () => {
  it("allows one Cockpit, started by a person, in its own directory", async () => {
    const { manager, dir, as } = hub();
    const c = await manager.create({ adapter: "claude-sdk", cwd: "/ignored", cockpit: true });
    expect(c).toMatchObject({ cockpit: true, pinned: true, cwd: path.join(dir, "cockpit") });
    await expect(manager.create({ adapter: "claude-sdk", cwd: "/x", cockpit: true })).rejects.toThrow(/already has a Cockpit/);
    await expect(as({ kind: "session", sessionId: c.id, role: "cockpit" }).request({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: dir, cockpit: true } })).rejects.toThrow(/only a person/);
  });

  it("lets a session read, message others with a label, and coordinate, but not control", async () => {
    const { manager, fake, as, dir } = hub();
    const a = await manager.create({ adapter: "claude-sdk", cwd: dir });
    const b = await manager.create({ adapter: "claude-sdk", cwd: dir });
    const api = as({ kind: "session", sessionId: a.id, role: "session" });

    expect(await api.request({ cmd: "hub.whoami" })).toMatchObject({ kind: "session", name: a.name, role: "session" });
    await api.request({ cmd: "session.send", sessionId: b.id, text: "please take src/b.ts" });
    expect(fake.instances[1]!.sent.at(-1)).toEqual({ text: `[Message from ${a.name}, another Loom session. It is not from the developer.]\nplease take src/b.ts`, from: "session" });
    await expect(api.request({ cmd: "session.send", sessionId: a.id, text: "hi me" })).rejects.toThrow(/cannot message itself/);
    await expect(api.request({ cmd: "session.stop", sessionId: b.id })).rejects.toThrow(/cannot use session.stop/);
    await expect(api.request({ cmd: "policy.get", cwd: dir })).rejects.toThrow(/cannot use policy.get/);
    await api.request({ cmd: "notes.set", cwd: dir, key: "plan", value: "a does api, b does ui" });
    expect(await api.request({ cmd: "notes.get", cwd: dir, key: "plan" })).toMatchObject({ by: a.name });
  });

  it("lets the Cockpit run sessions within limits, never itself or full", async () => {
    const { manager, as, dir } = hub();
    const c = await manager.create({ adapter: "claude-sdk", cwd: dir, cockpit: true });
    const api = as({ kind: "session", sessionId: c.id, role: "cockpit" });
    const s = await api.request({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: dir, prompt: "go" } });
    await api.request({ cmd: "session.set-level", sessionId: s.id, level: "assisted" });
    await expect(api.request({ cmd: "session.set-level", sessionId: s.id, level: "full" })).rejects.toThrow();
    await expect(api.request({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: dir, level: "full" } })).rejects.toThrow(/level full/);
    await expect(api.request({ cmd: "session.stop", sessionId: c.id })).rejects.toThrow(/cannot stop itself/);
    await api.request({ cmd: "session.stop", sessionId: s.id });
    expect(manager.get(s.id).live).toBe(false);
  });

  it("lets the Cockpit decide approvals only where models may, never its own or ask-rule matches", async () => {
    const off = hub();
    const offCockpit = await off.manager.create({ adapter: "claude-sdk", cwd: off.dir, cockpit: true });
    await off.manager.create({ adapter: "claude-sdk", cwd: off.dir });
    void off.fake.latest().ask(bash("npm test"));
    await flush();
    const offApi = off.as({ kind: "session", sessionId: offCockpit.id, role: "cockpit" });
    await expect(offApi.request({ cmd: "approval.decide", approvalId: off.manager.approvals()[0]!.id, decision: { type: "allow" } })).rejects.toThrow(/only a person may decide/);

    const on = hub({ stewardOn: true });
    const cockpit = await on.manager.create({ adapter: "claude-sdk", cwd: on.dir, cockpit: true });
    const cockpitAdapter = on.fake.latest();
    const worker = await on.manager.create({ adapter: "claude-sdk", cwd: on.dir });
    const api = on.as({ kind: "session", sessionId: cockpit.id, role: "cockpit" });

    const decision = on.fake.latest().ask(bash("npm test"));
    await flush();
    await api.request({ cmd: "approval.decide", approvalId: on.manager.approvals()[0]!.id, decision: { type: "allow" } });
    await expect(decision).resolves.toEqual({ type: "allow" });
    const resolved = on.manager.read(worker.id).find((e) => e.event.type === "approval.resolved")!.event;
    expect(resolved).toMatchObject({ resolver: "cockpit" });

    void cockpitAdapter.ask(bash("rm -rf /tmp/x"));
    await flush();
    const own = on.manager.approvals().find((a) => a.sessionId === cockpit.id)!;
    await expect(api.request({ cmd: "approval.decide", approvalId: own.id, decision: { type: "allow" } })).rejects.toThrow(/its own approvals/);
    await expect(api.request({ cmd: "approval.decide", approvalId: own.id, decision: { type: "allow-always" } })).rejects.toThrow();
  });

  it("waits for a session state or times out", async () => {
    const { manager, fake, dir } = hub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: dir, prompt: "go" });
    const waiting = manager.waitFor(s.id, ["idle"], 5000);
    fake.latest().reply("done", 0);
    await expect(waiting).resolves.toMatchObject({ state: "idle" });
    await expect(manager.waitFor(s.id, ["error"], 20)).resolves.toMatchObject({ state: "idle" });
  });
});

describe("loom tools", () => {
  it("run a small mission for the Cockpit: start, wait, read, notes, claims, board", async () => {
    const { manager, fake, as, dir } = hub();
    const c = await manager.create({ adapter: "claude-sdk", cwd: dir, cockpit: true });
    const api = as({ kind: "session", sessionId: c.id, role: "cockpit" });
    const tools = loomTools({ sessionId: c.id, name: c.name, role: "cockpit", cwd: c.cwd, projectRoot: dir });
    const t = (name: string) => tools.find((x) => x.name === name)!;

    const started = await runTool(t("start_session"), { project: dir, prompt: "write tests", name: "Tester" }, api);
    expect(started).toMatchObject({ isError: false, text: expect.stringContaining("Started Tester") });
    const waiting = runTool(t("wait_for"), { session: "tester", timeout_seconds: 5 }, api);
    await flush();
    fake.latest().reply("All tests pass.", 0.02);
    expect((await waiting).text).toMatch(/^Reached Tester .* idle/);
    expect((await runTool(t("read_session"), { session: "Tester" }, api)).text).toMatch(/Latest reply:\nAll tests pass\./);
    expect((await runTool(t("list_sessions"), {}, api)).text).toMatch(/Tester \[\w{8}\] idle · chat/);
    expect((await runTool(t("notes"), { action: "set", key: "status", value: "tests done" }, api)).isError).toBe(false);
    expect((await runTool(t("claims"), { action: "claim", path: "src/a.ts" }, api)).text).toBe("Claimed src/a.ts.");
    expect((await runTool(t("board"), { action: "add", title: "Refactor" }, api)).text).toMatch(/todo: Refactor/);
    expect((await runTool(t("read_session"), { session: "nobody" }, api))).toEqual({ isError: true, text: "no session called nobody" });
  });

  it("show sessions only the tools their role may use", () => {
    const base = { sessionId: "s", name: "Faye", cwd: "/r", projectRoot: "/r" };
    const session = loomTools({ ...base, role: "session" }).map((t) => t.name);
    const cockpit = loomTools({ ...base, role: "cockpit" }).map((t) => t.name);
    expect(session).not.toContain("start_session");
    expect(cockpit).toEqual(expect.arrayContaining(["start_session", "decide_approval", "pending_approvals", ...session]));
  });
});

describe("tool listing", () => {
  it("lists every tool for both roles through a real MCP client, in process and over stdio shapes", async () => {
    const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    for (const role of ["session", "cockpit"] as const) {
      const defs = loomTools({ sessionId: "s", name: "Faye", role, cwd: "/tmp", projectRoot: "/tmp" });
      const server = createSdkMcpServer({ name: "loom", tools: defs.map((t) => tool(t.name, t.description, t.shape as Record<string, never>, async () => ({ content: [] }))) });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await (server as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(a);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(b);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(defs.map((t) => t.name).sort());
      await client.close();
    }
  });
});

describe("transports", () => {
  async function served() {
    const h = hub();
    const server = await startHubServer({
      manager: h.manager,
      boards: h.boards,
      hub: { id: "h", name: "t", version: "0", platform: "linux", maxLevel: "assisted", defaultLevel: "supervised", stewardModel: false },
      tokenHash: hashToken("human-token"),
      hosts: ["127.0.0.1"],
      port: 0,
    });
    cleanups.push(() => server.close());
    const s = await h.manager.create({ adapter: "claude-sdk", cwd: h.dir });
    const token = h.manager.tokens.issue(s.id, "session");
    return { ...h, server, s, token, url: `http://127.0.0.1:${server.port}` };
  }

  it("logs a session in with its token, as that session", async () => {
    const { server, s, token } = await served();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => ws.close());
    const welcome = await new Promise<{ you: unknown }>((resolve) => {
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1, client: { kind: "cli", version: "t" }, token })));
      ws.on("message", (d) => resolve(JSON.parse(d.toString())));
    });
    expect(welcome.you).toEqual({ kind: "session", sessionId: s.id, name: s.name, role: "session" });
  });

  it("serves the loom tools over stdio MCP", async () => {
    const { url, token, s } = await served();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/loom/stdioServer.ts", import.meta.url))],
      env: { ...(process.env as Record<string, string>), LOOM_HUB_URL: url, LOOM_SESSION_TOKEN: token },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_sessions", "notes", "claims"]));
    expect(tools.map((t) => t.name)).not.toContain("start_session");
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain(`You are ${s.name} (session)`);
  }, 20_000);

  it("runs the loom CLI with a session token, and refuses what the role cannot do", async () => {
    const { url, token, s } = await served();
    const cli = fileURLToPath(new URL("../src/loom/cli.ts", import.meta.url));
    const env = { ...process.env, LOOM_HUB_URL: url, LOOM_SESSION_TOKEN: token };
    const list = await run(process.execPath, [cli, "list"], { env });
    expect(list.stdout).toContain(s.name);
    await run(process.execPath, [cli, "notes", "plan", "ship", "it"], { env });
    expect((await run(process.execPath, [cli, "notes", "plan"], { env })).stdout).toContain("plan (by");
    const refused = await run(process.execPath, [cli, "start_session", "--project", "/tmp"], { env }).catch((e: { code: number; stderr: string }) => e);
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining("unknown command start_session") });
  }, 20_000);

  it("ignores Loom v1 hook commands so old Claude settings cannot block prompts", async () => {
    const cli = fileURLToPath(new URL("../src/loom/cli.ts", import.meta.url));
    const child = execFile(process.execPath, [cli, "hook", "prompt"], { env: { PATH: process.env.PATH ?? "" } });
    child.stdin?.end('{"hook_event_name":"UserPromptSubmit","prompt":"hi"}');
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(0);
  });
});

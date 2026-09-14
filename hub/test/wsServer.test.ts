import { type HubEvent, type HubFrame, PROTOCOL_VERSION } from "@loom/protocol";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { hashToken } from "../src/auth.ts";
import { LoginLimiter } from "../src/remote/loginLimiter.ts";
import { CloseCode, type HubServer, startHubServer } from "../src/server/wsServer.ts";
import { bashApproval } from "./support/fakeAdapter.ts";
import { testHub } from "./support/hub.ts";

const TOKEN = "test-token";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(extra: { staticDir?: string; limiter?: LoginLimiter; hosts?: string[]; tls?: { cert: Buffer; key: Buffer; hosts: string[] } } = {}) {
  const hub = testHub();
  const server: HubServer = await startHubServer({
    manager: hub.manager,
    hub: {
      id: "hub-1",
      name: "test",
      version: "0.0.0",
      platform: "linux",
      maxLevel: "accept-edits",
      defaultLevel: "supervised",
      stewardModel: false,
    },
    tokenHash: hashToken(TOKEN),
    hosts: ["127.0.0.1"],
    port: 0,
    helloTimeoutMs: 500,
    ...extra,
  });
  cleanups.push(() => server.close());
  return { ...hub, server };
}

/** Minimal protocol client for tests. */
class TestClient {
  ws: WebSocket;
  frames: HubFrame[] = [];
  closed: Promise<{ code: number; reason: string }>;
  #nextId = 1;
  #waiters: Array<() => void> = [];

  constructor(port: number, host = "127.0.0.1") {
    this.ws = new WebSocket(`ws://${host}:${port}/ws`);
    this.ws.on("message", (d) => {
      this.frames.push(JSON.parse(d.toString()) as HubFrame);
      for (const w of this.#waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => this.ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    cleanups.push(() => this.ws.close());
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  raw(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  async next<T extends HubFrame>(match: (f: HubFrame) => f is T, ms = 2000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex(match);
      if (i >= 0) return this.frames.splice(i, 1)[0] as T;
      if (Date.now() > end) throw new Error(`frame not received; have ${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        this.#waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  async hello(token = TOKEN, protocol = PROTOCOL_VERSION) {
    await this.open();
    this.raw({ t: "hello", protocol, client: { kind: "web", version: "test" }, token });
    return this.next((f): f is Extract<HubFrame, { t: "welcome" }> => f.t === "welcome");
  }

  async req(body: unknown) {
    const id = this.#nextId++;
    this.raw({ t: "req", id, body });
    return this.next((f): f is Extract<HubFrame, { t: "res" }> => f.t === "res" && f.id === id);
  }

  events(): HubEvent[] {
    const out: HubEvent[] = [];
    this.frames = this.frames.filter((f) => {
      if (f.t !== "evt") return true;
      out.push(f.e);
      return false;
    });
    return out;
  }
}

describe("hub WebSocket server", () => {
  it("welcomes a client with the right token and hub info", async () => {
    const { server } = await boot();
    const c = new TestClient(server.port);
    const welcome = await c.hello();
    expect(welcome).toMatchObject({ protocol: PROTOCOL_VERSION, hub: { id: "hub-1", maxLevel: "accept-edits" }, headSeq: 0 });
  });

  it("closes on a wrong token, a protocol mismatch, a request before hello, and silence", async () => {
    const { server } = await boot();

    const wrong = new TestClient(server.port);
    await wrong.open();
    wrong.raw({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "t" }, token: "nope" });
    expect((await wrong.closed).code).toBe(CloseCode.unauthorized);

    const old = new TestClient(server.port);
    await old.open();
    old.raw({ t: "hello", protocol: 999, client: { kind: "web", version: "t" }, token: TOKEN });
    expect((await old.closed).code).toBe(CloseCode.protocolMismatch);

    const eager = new TestClient(server.port);
    await eager.open();
    eager.raw({ t: "req", id: 1, body: { cmd: "session.list" } });
    expect((await eager.closed).code).toBe(CloseCode.unauthorized);

    const silent = new TestClient(server.port);
    await silent.open();
    expect((await silent.closed).code).toBe(CloseCode.helloTimeout);
  });

  it("blocks an address after repeated wrong tokens, even when it then sends the right one", async () => {
    const { server } = await boot({ limiter: new LoginLimiter({ max: 3 }) });
    for (let i = 0; i < 3; i++) {
      const wrong = new TestClient(server.port);
      await wrong.open();
      wrong.raw({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "t" }, token: `guess-${i}` });
      expect((await wrong.closed).reason).toBe("invalid token");
    }
    const right = new TestClient(server.port);
    await right.open();
    right.raw({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "t" }, token: TOKEN });
    expect(await right.closed).toMatchObject({ code: CloseCode.unauthorized, reason: expect.stringMatching(/too many/) });
  });

  it("listens on every host on one port", async () => {
    const { server } = await boot({ hosts: ["127.0.0.1", "127.0.0.2"] });
    for (const host of ["127.0.0.1", "127.0.0.2"]) {
      const c = new TestClient(server.port, host);
      expect((await c.hello()).hub.id).toBe("hub-1");
    }
  });

  it("refuses hook calls that came through a proxy", async () => {
    const { server } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/hooks/s1`, { method: "POST", body: "{}", headers: { "x-forwarded-for": "100.70.1.2" } });
    expect(res.status).toBe(403);
  });

  it.skipIf(!hasOpenssl())("serves TLS on the hosts given and plain HTTP on the rest", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-tls-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=loom-test", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    const tls = { cert: readFileSync(path.join(dir, "cert.pem")), key: readFileSync(path.join(dir, "key.pem")), hosts: ["127.0.0.2"] };
    const { server } = await boot({ hosts: ["127.0.0.1", "127.0.0.2"], tls });
    const plain = await fetch(`http://127.0.0.1:${server.port}/loom.json`);
    expect(plain.status).toBe(200);
    const secure = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({ host: "127.0.0.2", port: server.port, path: "/loom.json", rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(secure)).toMatchObject({ loom: "hub" });
    await expect(fetch(`http://127.0.0.2:${server.port}/loom.json`)).rejects.toThrow();
  });

  it("accepts hook calls from loopback (the non-loopback refusal is covered by isLoopback)", async () => {
    const { server } = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/hooks/s1`, { method: "POST", body: "{}" });
    expect(res.status).not.toBe(403);
  });

  it("answers commands and reports protocol errors without dropping the connection", async () => {
    const { server } = await boot();
    const c = new TestClient(server.port);
    await c.hello();

    const created = await c.req({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: "/repo", prompt: "hi" } });
    expect(created).toMatchObject({ ok: true, data: { name: "Faye", live: true } });

    expect(await c.req({ cmd: "session.stop", sessionId: "missing" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await c.req({ cmd: "session.create", spec: { adapter: "claude-sdk", cwd: "/repo", level: "full" } })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await c.req({ cmd: "nonsense" })).toMatchObject({ ok: false, error: { code: "bad-frame" } });
    expect(await c.req({ cmd: "terminal.write", sessionId: "x", data: "" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await c.req({ cmd: "session.list" })).toMatchObject({ ok: true, data: [{ name: "Faye" }] });
  });

  it("replays after a seq and then streams live events without gaps or duplicates", async () => {
    const { server, manager, fake } = await boot();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "one" });
    fake.latest().reply("first", 0.1);
    const midHead = manager.head();
    fake.latest().reply("second", 0.2);

    const c = new TestClient(server.port);
    await c.hello();
    const sub = await c.req({ cmd: "events.subscribe", since: midHead });
    expect(sub).toMatchObject({ ok: true, data: { head: manager.head() } });

    await manager.send(s.id, "live one");
    fake.latest().reply("third", 0.3);

    await new Promise((r) => setTimeout(r, 50));
    const seqs = c.events().map((e) => e.seq);
    const expected = manager.replay(midHead, undefined, 1000).map((e) => e.seq);
    expect(seqs).toEqual(expected);
    expect(seqs[0]).toBe(midHead + 1);
  });

  it("gives a consistent snapshot to build from and filters subscriptions by session", async () => {
    const { server, manager, fake } = await boot();
    const a = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "a" });
    await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "b" });
    void fake.instances[0]!.ask(bashApproval);

    const c = new TestClient(server.port);
    await c.hello();
    const snap = await c.req({ cmd: "hub.snapshot" });
    expect(snap).toMatchObject({ ok: true, data: { head: manager.head(), approvals: [{ summary: "Run: npm test" }] } });
    expect((snap as { data: { sessions: unknown[] } }).data.sessions).toHaveLength(2);

    await c.req({ cmd: "events.subscribe", sessionIds: [a.id] });
    fake.instances[1]!.reply("not for you", 1);
    fake.instances[0]!.reply("for you", 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(new Set(c.events().map((e) => e.sessionId))).toEqual(new Set([a.id]));
  });

  it("lets a client decide an approval and another client see it resolved", async () => {
    const { server, manager, fake } = await boot();
    await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    const decision = fake.latest().ask(bashApproval);

    const watcher = new TestClient(server.port);
    await watcher.hello();
    await watcher.req({ cmd: "events.subscribe" });
    const actor = new TestClient(server.port);
    await actor.hello();

    const [pending] = manager.approvals();
    expect(await actor.req({ cmd: "approval.decide", approvalId: pending!.id, decision: { type: "deny", message: "not now" } })).toMatchObject({ ok: true });
    await expect(decision).resolves.toMatchObject({ type: "deny", message: "not now" });

    await new Promise((r) => setTimeout(r, 50));
    expect(watcher.events().map((e) => e.event.type)).toContain("approval.resolved");
  });

  it("serves the built client and refuses paths outside it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-static-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Loom</title>");
    writeFileSync(path.join(dir, "app.js"), "console.log(1)");
    const { server } = await boot({ staticDir: dir });
    const base = `http://127.0.0.1:${server.port}`;

    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    const deep = await fetch(`${base}/sessions/abc`);
    expect(await deep.text()).toContain("<title>Loom</title>");
    const escape = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(await escape.text()).toContain("<title>Loom</title>");
  });
});

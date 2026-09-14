import { describe, expect, it } from "vitest";
import { EventLog } from "../src/log/eventLog.ts";
import { bashApproval, colorQuestion } from "./support/fakeAdapter.ts";
import { flush, testHub } from "./support/hub.ts";

describe("SessionManager", () => {
  it("creates a session, starts its engine, and sends the first prompt", async () => {
    const { manager, fake, types } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "Fix the login test" });

    expect(s).toMatchObject({ name: "Faye", live: true, level: "supervised", subtitle: "Fix the login test" });
    expect(fake.latest().sent).toEqual([{ text: "Fix the login test", from: "human" }]);
    expect(types()).toEqual([
      "session.created",
      "session.engine",
      "session.live",
      "session.state",
      "user.message",
      "session.state",
    ]);
    expect(manager.get(s.id).state).toBe("working");
  });

  it("gives each session a distinct name", async () => {
    const { manager } = testHub();
    const a = await manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    const b = await manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    expect([a.name, b.name]).toEqual(["Faye", "Cleo"]);
  });

  it("rejects a missing directory, a level above the hub max, and worktrees", async () => {
    const { manager } = testHub();
    await expect(manager.create({ adapter: "claude-sdk", cwd: "/nope" })).rejects.toMatchObject({ code: "invalid" });
    await expect(manager.create({ adapter: "claude-sdk", cwd: "/repo", level: "full" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      manager.create({ adapter: "claude-sdk", cwd: "/repo", worktree: { branch: "x" } }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("marks a session errored when its engine fails to start", async () => {
    const { manager } = testHub({ failStart: "no login" });
    await expect(manager.create({ adapter: "claude-sdk", cwd: "/repo" })).rejects.toMatchObject({ code: "engine" });
    expect(manager.list()[0]).toMatchObject({ state: "error", live: false });
  });

  it("blocks on a permission approval and resumes working after a human allows it", async () => {
    const { manager, fake } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });

    const decision = fake.latest().ask(bashApproval);
    expect(manager.get(s.id)).toMatchObject({ state: "blocked", blockedOn: "approval" });
    const [pending] = manager.approvals();
    expect(pending).toMatchObject({ kind: "permission", sessionId: s.id, summary: "Run: npm test" });

    manager.decide(pending!.id, { type: "allow" });
    await expect(decision).resolves.toEqual({ type: "allow" });
    await flush();
    expect(manager.get(s.id).state).toBe("working");
    expect(manager.approvals()).toEqual([]);
  });

  it("stays blocked until every parallel approval is decided", async () => {
    const { manager, fake } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    const one = fake.latest().ask(bashApproval);
    const two = fake.latest().ask(colorQuestion);
    const [a, b] = manager.approvals();

    manager.decide(a!.id, { type: "deny", message: "no" });
    await one;
    await flush();
    expect(manager.get(s.id).state).toBe("blocked");

    manager.decide(b!.id, { type: "answer", answers: { "Red or Blue?": "Blue" } });
    await two;
    await flush();
    expect(manager.get(s.id).state).toBe("working");
  });

  it("refuses decisions that do not fit the approval", async () => {
    const { manager, fake } = testHub();
    await manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    void fake.latest().ask(colorQuestion);
    const [q] = manager.approvals();
    expect(() => manager.decide(q!.id, { type: "allow" })).toThrow(/does not apply/);
    expect(() => manager.decide("missing", { type: "allow" })).toThrow(/no open approval/);
  });

  it("cancels an approval when the engine aborts the request", async () => {
    const { manager, fake } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    const controller = new AbortController();
    const decision = fake.latest().ask(bashApproval, controller.signal);
    controller.abort();
    await expect(decision).resolves.toMatchObject({ type: "deny" });
    expect(manager.approvals()).toEqual([]);
    await flush();
    expect(manager.get(s.id).state).toBe("working");
  });

  it("stopping denies open approvals, keeps the session resumable, and resumes on send", async () => {
    const { manager, fake } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    fake.latest().reply("done", 0.25);
    const decision = fake.latest().ask(bashApproval);

    await manager.stop(s.id);
    await expect(decision).resolves.toMatchObject({ type: "deny" });
    expect(fake.latest().stopped).toBe(true);
    expect(manager.get(s.id)).toMatchObject({ live: false, state: "idle" });

    await manager.send(s.id, "carry on");
    expect(fake.instances).toHaveLength(2);
    expect(fake.latest().started).toMatchObject({ resumeEngineSessionId: `engine-${s.id}`, costBase: 0.25 });
    expect(manager.get(s.id)).toMatchObject({ live: true, state: "working" });
  });

  it("drops events from an adapter instance after it was stopped", async () => {
    const { manager, fake } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo" });
    const old = fake.latest();
    await manager.stop(s.id);
    old.reply("late", 9);
    expect(manager.get(s.id).costUsd).toBe(0);
  });

  it("treats an engine exit as idle and resumable, and records the error", async () => {
    const { manager, fake, types } = testHub();
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    fake.latest().host.exited("process crashed");
    expect(manager.get(s.id)).toMatchObject({ live: false, state: "idle" });
    expect(types()).toContain("error");
  });

  it("enforces level rules for humans and the cockpit", async () => {
    const { manager, fake } = testHub({ maxLevel: "full", defaultLevel: "supervised" });
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/repo" });

    await manager.setLevel(s.id, "assisted", "cockpit");
    await expect(manager.setLevel(s.id, "full", "cockpit")).rejects.toMatchObject({ code: "forbidden" });
    await manager.setLevel(s.id, "full", "human");
    expect(manager.get(s.id).level).toBe("full");
    expect(fake.latest().levels).toEqual(["assisted", "full"]);
  });

  it("settles running sessions and open approvals left by a previous hub process", async () => {
    const log = new EventLog(":memory:", "h");
    const first = testHub({ log });
    const s = await first.manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "go" });
    void first.fake.latest().ask(bashApproval);
    expect(first.manager.get(s.id).state).toBe("blocked");

    const second = testHub({ log });
    expect(second.manager.get(s.id)).toMatchObject({ state: "idle", live: false });
    expect(second.manager.approvals()).toEqual([]);
    const resolved = log.readSince(0).filter((e) => e.event.type === "approval.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.event).toMatchObject({ resolver: "hub" });
  });

  it("reads a session's history from the log", async () => {
    const { manager, fake } = testHub();
    const a = await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "one" });
    await manager.create({ adapter: "claude-sdk", cwd: "/repo", prompt: "two" });
    fake.instances[0]!.reply("hi", 0.1);
    const history = manager.read(a.id);
    expect(history.every((e) => e.sessionId === a.id)).toBe(true);
    expect(history.map((e) => e.event.type)).toContain("assistant.text");
  });
});

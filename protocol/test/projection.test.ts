import { describe, expect, it } from "vitest";
import { applyEvent, createProjection, type SessionEvent } from "../src/index.ts";
import { stream, summary } from "./fixtures.ts";

const lifecycle: SessionEvent[] = [
  { type: "session.created", summary: summary(), spec: { adapter: "claude-sdk", cwd: "/repo" } },
  { type: "session.live", live: true },
  { type: "user.message", text: "Fix the flaky login test\nand more detail", from: "human" },
  { type: "session.state", state: "working", provenance: "pushed" },
  { type: "session.engine", engineSessionId: "claude-uuid", model: "claude-opus-5" },
  {
    type: "approval.requested",
    request: {
      kind: "permission",
      id: "a1",
      sessionId: "s1",
      requestedAt: 2005,
      summary: "Run: npm test",
      toolName: "Bash",
      input: { command: "npm test" },
      canAlwaysAllow: false,
    },
  },
  { type: "session.state", state: "blocked", blockedOn: "approval", provenance: "pushed" },
  { type: "approval.resolved", approvalId: "a1", decision: { type: "allow" }, resolver: "human" },
  { type: "session.state", state: "working", provenance: "pushed" },
  { type: "cost.update", costUsd: 0.12 },
  { type: "session.state", state: "idle", provenance: "pushed" },
];

describe("projection", () => {
  it("folds a session lifecycle into a summary", () => {
    const p = createProjection();
    for (const e of stream(lifecycle)) applyEvent(p, e);
    const s = p.sessions.get("s1");
    expect(s).toMatchObject({
      state: "idle",
      live: true,
      engineSessionId: "claude-uuid",
      model: "claude-opus-5",
      costUsd: 0.12,
      subtitle: "Fix the flaky login test",
      updatedAt: 2010,
    });
    expect(s?.blockedOn).toBeUndefined();
    expect(p.pending.size).toBe(0);
    expect(p.head).toBe(11);
  });

  it("tracks a pending approval while blocked", () => {
    const p = createProjection();
    for (const e of stream(lifecycle.slice(0, 7))) applyEvent(p, e);
    expect(p.sessions.get("s1")).toMatchObject({ state: "blocked", blockedOn: "approval" });
    expect([...p.pending.keys()]).toEqual(["a1"]);
  });

  it("converges when a suffix of the log is applied twice (snapshot then replay)", () => {
    const events = stream(lifecycle);
    const once = createProjection();
    for (const e of events) applyEvent(once, e);

    const twice = createProjection();
    for (const e of events.slice(0, 8)) applyEvent(twice, e);
    for (const e of events.slice(3)) applyEvent(twice, e);

    expect(twice.sessions.get("s1")).toEqual(once.sessions.get("s1"));
    expect(twice.pending).toEqual(once.pending);
  });

  it("clears pending approvals and liveness when a session ends", () => {
    const p = createProjection();
    for (const e of stream([...lifecycle.slice(0, 7), { type: "session.ended", outcome: "error", message: "crash" }]))
      applyEvent(p, e);
    expect(p.sessions.get("s1")).toMatchObject({ state: "error", live: false, stateProvenance: "hub" });
    expect(p.pending.size).toBe(0);
  });

  it("ignores events for sessions it has not seen created", () => {
    const p = createProjection();
    for (const e of stream([{ type: "cost.update", costUsd: 1 }], "ghost")) applyEvent(p, e);
    expect(p.sessions.size).toBe(0);
  });
});

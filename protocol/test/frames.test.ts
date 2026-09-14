import { describe, expect, it } from "vitest";
import {
  EPHEMERAL_EVENT_TYPES,
  parseClientFrame,
  parseHubFrame,
  PROTOCOL_VERSION,
  SessionEvent,
  type SessionEventType,
} from "../src/index.ts";

describe("parseClientFrame", () => {
  it("accepts a hello", () => {
    const r = parseClientFrame(
      JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "0.0.0" } }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a session.create request", () => {
    const r = parseClientFrame(
      JSON.stringify({
        t: "req",
        id: 1,
        body: { cmd: "session.create", spec: { adapter: "claude-sdk", cwd: "/home/me/repo", level: "supervised" } },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.t === "req") expect(r.value.body.cmd).toBe("session.create");
  });

  it("accepts an answer to a clarifying question", () => {
    const r = parseClientFrame(
      JSON.stringify({
        t: "req",
        id: 2,
        body: {
          cmd: "approval.decide",
          approvalId: "a1",
          decision: { type: "answer", answers: { "Red or Blue?": "Blue" } },
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(parseClientFrame("{not json")).toEqual({ ok: false, error: "frame is not valid JSON" });
  });

  it("rejects unknown commands", () => {
    const r = parseClientFrame(JSON.stringify({ t: "req", id: 3, body: { cmd: "session.explode" } }));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown permission level", () => {
    const r = parseClientFrame(
      JSON.stringify({ t: "req", id: 4, body: { cmd: "session.set-level", sessionId: "s1", level: "yolo" } }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseHubFrame", () => {
  it("accepts an event frame carrying a permission approval", () => {
    const r = parseHubFrame(
      JSON.stringify({
        t: "evt",
        e: {
          seq: 42,
          at: 1_757_700_000_000,
          hubId: "home",
          sessionId: "s1",
          event: {
            type: "approval.requested",
            request: {
              kind: "permission",
              id: "a1",
              sessionId: "s1",
              requestedAt: 1_757_700_000_000,
              summary: "Run: npm test",
              toolName: "Bash",
              input: { command: "npm test" },
              canAlwaysAllow: true,
            },
          },
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts both response shapes", () => {
    expect(parseHubFrame(JSON.stringify({ t: "res", id: 1, ok: true, data: [] })).ok).toBe(true);
    expect(
      parseHubFrame(JSON.stringify({ t: "res", id: 1, ok: false, error: { code: "not-found", message: "no such session" } }))
        .ok,
    ).toBe(true);
  });
});

describe("events", () => {
  it("ephemeral event types are real event types", () => {
    const known = new Set<SessionEventType>(SessionEvent.options.map((o) => o.shape.type.value));
    for (const t of EPHEMERAL_EVENT_TYPES as readonly SessionEventType[]) expect(known.has(t)).toBe(true);
    expect(known.has("terminal.output" as SessionEventType)).toBe(false);
  });

  it("accepts a term frame and a terminal attach request", () => {
    expect(parseHubFrame(JSON.stringify({ t: "term", sessionId: "s1", offset: 1024, data: "aGk=" })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: "req", id: 9, body: { cmd: "terminal.attach", sessionId: "s1" } })).ok).toBe(true);
  });
});

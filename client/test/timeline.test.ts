import type { HubEvent, SessionEvent } from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { buildTimeline, describeResolution, mergeEvents } from "../src/lib/timeline.ts";

const at = (events: SessionEvent[], start = 1): HubEvent[] =>
  events.map((event, i) => ({ seq: start + i, at: 1000 + i, hubId: "h", sessionId: "s", event }));

describe("buildTimeline", () => {
  it("attaches tool results and approval resolutions to their origin", () => {
    const items = buildTimeline(
      at([
        { type: "user.message", text: "run tests", from: "human" },
        { type: "tool.use", toolUseId: "t1", toolName: "Bash", input: { command: "npm test" } },
        {
          type: "approval.requested",
          request: { kind: "permission", id: "a1", sessionId: "s", requestedAt: 1, summary: "Run: npm test", toolName: "Bash", input: {}, canAlwaysAllow: false },
        },
        { type: "approval.resolved", approvalId: "a1", decision: { type: "allow" }, resolver: "human" },
        { type: "tool.result", toolUseId: "t1", isError: false, preview: "12 passed" },
        { type: "assistant.text", messageId: "m", text: "All green." },
        { type: "session.state", state: "idle", provenance: "pushed" },
      ]),
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "approval", "assistant"]);
    expect(items[1]).toMatchObject({ result: { preview: "12 passed" } });
    expect(items[2]).toMatchObject({ resolution: { resolver: "human" } });
  });

  it("marks subagent output as nested", () => {
    const [item] = buildTimeline(at([{ type: "assistant.text", messageId: "m", text: "sub", parentToolUseId: "p" }]));
    expect(item).toMatchObject({ nested: true });
  });
});

describe("mergeEvents", () => {
  it("dedupes by seq and keeps order", () => {
    const a = at([{ type: "cost.update", costUsd: 1 }, { type: "cost.update", costUsd: 2 }]);
    const b = at([{ type: "cost.update", costUsd: 2 }, { type: "cost.update", costUsd: 3 }], 2);
    expect(mergeEvents(b, a).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("describeResolution", () => {
  it("reads naturally", () => {
    expect(describeResolution({ type: "deny", message: "not now" }, "human")).toBe("Denied by you: not now");
    expect(describeResolution({ type: "deny", message: "The session was stopped." }, "hub")).toBe("Cancelled: The session was stopped.");
    expect(describeResolution({ type: "answer", answers: { q: ["A", "B"] } }, "human")).toBe("Answered by you: A, B");
  });
});

describe("describeResolution for rules and timeouts", () => {
  it("names the rule and where it lives", () => {
    const rule = { list: "deny" as const, rule: "Bash(rm *)", scope: "project" as const, path: "/r/.loom/policy.json" };
    expect(describeResolution({ type: "deny", message: "x" }, "rule", rule)).toBe("Denied by rule Bash(rm *) · project policy");
    expect(describeResolution({ type: "deny", message: "No decision within 5 minutes." }, "timeout")).toBe("Timed out: No decision within 5 minutes.");
    expect(describeResolution({ type: "allow-rule", rule: "Bash(npm ci)", scope: "hub" }, "human")).toBe("Allowed by you, saved rule Bash(npm ci) to hub policy");
  });
});

describe("Steward in the timeline", () => {
  it("shows the review from the request, then updates, override", () => {
    const request = { kind: "permission" as const, id: "a1", sessionId: "s", requestedAt: 1, summary: "Run: x", toolName: "Bash", input: {}, canAlwaysAllow: false, steward: { status: "reviewing" as const, mode: "decide" as const } };
    const items = buildTimeline(
      at([
        { type: "approval.requested", request },
        { type: "approval.updated", approvalId: "a1", steward: { status: "done", mode: "decide", decision: "allow", confidence: 0.9, reason: "fine" } },
        { type: "approval.resolved", approvalId: "a1", decision: { type: "allow" }, resolver: "steward", detail: "90% confident, low risk: fine" },
        { type: "approval.overridden", approvalId: "a1", note: "not approved" },
      ]),
    );
    expect(items[0]).toMatchObject({ steward: { decision: "allow" }, resolution: { resolver: "steward" }, overridden: "not approved" });
    expect(buildTimeline(at([{ type: "approval.requested", request }]))[0]).toMatchObject({ steward: { status: "reviewing" } });
  });
});

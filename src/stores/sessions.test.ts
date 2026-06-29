// Proves the agent-awareness reducers (ADR-0008) build a correct Agent/Session/Task model from a
// sequence of pushed lifecycle signals — the Phase-1 "is the signal real without scraping?" check.

import { beforeEach, describe, expect, it } from "vitest";
import {
  sessions,
  tasks,
  livePane,
  sessionStart,
  sessionEnd,
  taskBegin,
  taskUpdate,
  taskEnd,
  approvalRequest,
  approvalResolve,
  resetSessions,
} from "./sessions";

beforeEach(() => resetSessions());

/** The Session currently Live in a Pane (via the paneId index). */
const live = (paneId: number) => {
  const id = livePane[paneId];
  return id != null ? sessions[id] : undefined;
};
/** A Session's Tasks, resolved. */
const taskList = (sessionId: string) =>
  (sessions[sessionId]?.taskIds ?? []).map((t) => tasks[t]);

describe("session lifecycle", () => {
  it("builds a Session from session.start, keyed by the agent's own id", () => {
    sessionStart(1, "claude", "sess-abc", "/repo");
    const s = live(1)!;
    expect(s.id).toBe("sess-abc");
    expect(s).toMatchObject({ paneId: 1, agentId: "claude", cwd: "/repo", state: "running", taskIds: [] });
    expect(typeof s.startedAt).toBe("number");
  });

  it("synthesizes a SessionId when the agent provides none", () => {
    sessionStart(1, "claude");
    expect(live(1)!.id).toMatch(/^s\d+$/);
  });

  it("treats a start while one is Live as a new Session (the old is superseded as done)", () => {
    sessionStart(1, "claude", "s-a");
    taskBegin(1, "claude", "t1");
    sessionStart(1, "claude", "s-b"); // e.g. a --resume

    expect(sessions["s-a"].state).toBe("done");
    expect(sessions["s-a"].endedAt).toBeTypeOf("number");
    expect(live(1)!.id).toBe("s-b");
    expect(live(1)!.taskIds).toEqual([]);
  });

  it("ends a Session, keeping its record as history (off the live index)", () => {
    sessionStart(1, "claude", "s1");
    sessionEnd(1, "done");
    expect(livePane[1]).toBeUndefined();
    expect(sessions["s1"].state).toBe("done");
    expect(sessions["s1"].endedAt).toBeTypeOf("number");
  });
});

describe("task lifecycle", () => {
  it("starts a running Task with the agent-pushed title", () => {
    sessionStart(1, "claude", "s1");
    taskBegin(1, "claude", "refactor auth");
    const [t] = taskList("s1");
    expect(t).toMatchObject({ title: "refactor auth", state: "running", files: [] });
    expect(live(1)!.state).toBe("running");
  });

  it("accumulates touched files, deduped, via task.update", () => {
    sessionStart(1, "claude", "s1");
    taskBegin(1, "claude", "edit");
    taskUpdate(1, "claude", ["src/auth.ts", "src/auth.ts"]);
    taskUpdate(1, "claude", ["src/login.ts", "src/auth.ts"]);
    expect(taskList("s1")[0].files).toEqual(["src/auth.ts", "src/login.ts"]);
  });

  it("finishes a dangling Task when the next one begins, and on task.end goes idle", () => {
    sessionStart(1, "claude", "s1");
    taskBegin(1, "claude", "t1");
    taskBegin(1, "claude", "t2"); // no explicit end for t1
    const [t1, t2] = taskList("s1");
    expect(t1.state).toBe("done");
    expect(t2.state).toBe("running");

    taskEnd(1, "done");
    expect(taskList("s1")[1].state).toBe("done");
    expect(live(1)!.state).toBe("idle");
  });
});

describe("approval", () => {
  it("blocks the active Task with the pushed prompt, then resolves", () => {
    sessionStart(1, "claude", "s1");
    taskBegin(1, "claude", "dangerous thing");
    approvalRequest(1, "claude", "Run `rm -rf build`?", "permission");

    const blocked = taskList("s1")[0];
    expect(blocked.state).toBe("blocked");
    expect(blocked.approval).toMatchObject({ prompt: "Run `rm -rf build`?", kind: "permission" });
    expect(live(1)!.state).toBe("blocked");

    approvalResolve(1);
    const resolved = taskList("s1")[0];
    expect(resolved.state).toBe("running");
    expect(resolved.approval!.resolvedAt).toBeTypeOf("number");
    expect(live(1)!.state).toBe("running");
  });
});

describe("graceful degradation (out-of-order / hook-less)", () => {
  it("lazily materializes a Session + Task when work arrives before session.start", () => {
    taskBegin(7, "claude", "just working");
    const s = live(7)!;
    expect(s).toBeDefined();
    expect(s.id).toMatch(/^s\d+$/);
    expect(taskList(s.id)[0]).toMatchObject({ title: "just working", state: "running" });
  });

  it("lazily creates a working Task when an approval arrives with no Task", () => {
    sessionStart(8, "claude", "s8");
    approvalRequest(8, "claude", "May I?", "question");
    const t = taskList("s8")[0];
    expect(t).toMatchObject({ title: "working", state: "blocked" });
    expect(t.approval).toMatchObject({ prompt: "May I?", kind: "question" });
  });
});

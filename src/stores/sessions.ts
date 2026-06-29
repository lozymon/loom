// The agent-awareness entity store (ADR-0008): durable Agent/Session/Task state, built only from
// agent-pushed lifecycle signals (the `session.*`/`task.*`/`approval.*` bus ops, fed by `loom
// hooks` / the MCP server) and the kernel floor — never from parsing pane output.
//
// Shape: two normalized maps — Sessions and Tasks — plus a paneId → live-SessionId index. A Pane
// has at most one *Live* Session; its prior Sessions stay in the map as history (a record outlives
// its Pane). Within a Session, one Task is "active" (running or blocked) at a time; an Approval is
// the payload a blocked Task carries, not its own entity.
//
// The reducers are deliberately tolerant: a task/approval signal that arrives before any
// session.start (a hook-less agent, or out-of-order delivery) lazily materializes the Session and
// an active Task, so coarse and rich agents both produce a coherent model. This store holds no UI;
// it is the model Phase-1 builds and proves, ahead of the fleet board (Phase 3).

import { createStore } from "solid-js/store";
import type {
  AgentId,
  PaneId,
  Session,
  SessionId,
  Task,
  TaskId,
  TaskOutcome,
  ApprovalKind,
} from "../ipc/protocol";

const [sessions, setSessions] = createStore<Record<SessionId, Session>>({});
const [tasks, setTasks] = createStore<Record<TaskId, Task>>({});
// paneId → the Session currently Live in that Pane (absent once it ends). Reactive so the future
// fleet board can read "what's running in Faye" directly.
const [livePane, setLivePane] = createStore<Record<PaneId, SessionId | undefined>>({});

/** Reactive read-only views (read `sessions[id]`, `tasks[id]`, `livePane[paneId]`). */
export { sessions, tasks, livePane };

// ---- read helpers for the fleet UI (reactive when called inside a tracking scope) ----

/** The active (running or blocked) Task of a Pane's Live Session, or undefined. */
export function paneActiveTask(paneId: PaneId): Task | undefined {
  const session = liveSession(paneId);
  if (!session) return undefined;
  const id = activeTaskId(session);
  return id != null ? tasks[id] : undefined;
}

// Synthesized ids for sessions an agent doesn't name, and for tasks (agents never name tasks
// stably). Monotonic per process; the agent's own session id is preferred for SessionId.
let synthSeq = 0;
const synthSessionId = (): SessionId => `s${++synthSeq}`;
const taskId = (): TaskId => `t${++synthSeq}`;

const now = (): number => Date.now();

// Persistence sink (ADR-0009): the app wires this to the SQLite client (lib/sessionLogClient.ts);
// tests leave it unset so the reducers stay pure and decoupled. Each mutator persists the row it
// just changed — best-effort, so a failed write never disrupts the live store.
type Sink = { session: (s: Session) => void; task: (t: Task) => void };
let sink: Sink | null = null;
export function setSessionSink(s: Sink | null): void {
  sink = s;
}
function persistSession(id: SessionId): void {
  if (sink && sessions[id]) sink.session(sessions[id]);
}
function persistTask(id: TaskId): void {
  if (sink && tasks[id]) sink.task(tasks[id]);
}

/** The Session Live in `paneId`, if any. */
function liveSession(paneId: PaneId): Session | undefined {
  const id = livePane[paneId];
  return id != null ? sessions[id] : undefined;
}

/** The active (running or blocked) Task of a Session — the last one not yet finished. */
function activeTaskId(session: Session): TaskId | undefined {
  for (let i = session.taskIds.length - 1; i >= 0; i--) {
    const t = tasks[session.taskIds[i]];
    if (t && (t.state === "running" || t.state === "blocked")) return t.id;
  }
  return undefined;
}

/** Get or lazily create the Live Session for a Pane (covers hook-less / out-of-order agents). */
function ensureSession(paneId: PaneId, agentId: AgentId, cwd = ""): Session {
  const existing = liveSession(paneId);
  if (existing) return existing;
  return createSession(paneId, agentId, synthSessionId(), cwd);
}

function createSession(paneId: PaneId, agentId: AgentId, id: SessionId, cwd: string): Session {
  const session: Session = {
    id,
    paneId,
    agentId,
    cwd,
    startedAt: now(),
    state: "running",
    taskIds: [],
  };
  setSessions(id, session);
  setLivePane(paneId, id);
  persistSession(id);
  return session;
}

/** End a Session's active Task (if any), then the Session itself, and unlink it from its Pane. */
function endSession(paneId: PaneId, outcome: TaskOutcome): void {
  const session = liveSession(paneId);
  if (!session) return;
  const active = activeTaskId(session);
  if (active) finishTask(active, outcome);
  setSessions(session.id, "state", outcome);
  setSessions(session.id, "endedAt", now());
  persistSession(session.id);
  setLivePane(paneId, undefined);
}

function finishTask(id: TaskId, outcome: TaskOutcome): void {
  if (tasks[id]?.state === "done" || tasks[id]?.state === "failed") return;
  setTasks(id, "state", outcome);
  setTasks(id, "endedAt", now());
  setTasks(id, "approval", undefined);
  persistTask(id);
}

/** Get the active Task for a Pane's Live Session, lazily creating both if absent. */
function ensureActiveTask(paneId: PaneId, agentId: AgentId, title = "working"): TaskId {
  const session = ensureSession(paneId, agentId);
  const active = activeTaskId(session);
  if (active) return active;
  return startTask(session, title);
}

function startTask(session: Session, title: string): TaskId {
  const id = taskId();
  const task: Task = {
    id,
    sessionId: session.id,
    title,
    state: "running",
    startedAt: now(),
    files: [],
  };
  setTasks(id, task);
  setSessions(session.id, "taskIds", (ids) => [...ids, id]);
  setSessions(session.id, "state", "running");
  persistTask(id);
  persistSession(session.id);
  return id;
}

// ---- bus-op reducers (called from lib/paneControl.ts) ----

/** `session.start` — begin a run. A start while one is Live supersedes the old (it never closed). */
export function sessionStart(
  paneId: PaneId,
  agentId: AgentId,
  sessionId?: string,
  cwd = "",
): void {
  if (liveSession(paneId)) endSession(paneId, "done");
  createSession(paneId, agentId, sessionId?.trim() || synthSessionId(), cwd);
}

/** `session.end` — close the Live run (defaults to a clean finish). */
export function sessionEnd(paneId: PaneId, outcome: TaskOutcome = "done"): void {
  endSession(paneId, outcome);
}

/** `task.begin` — start a unit of work; a new begin finishes any dangling prior Task. */
export function taskBegin(paneId: PaneId, agentId: AgentId, title: string): void {
  const session = ensureSession(paneId, agentId);
  const prev = activeTaskId(session);
  if (prev) finishTask(prev, "done");
  startTask(session, title.trim() || "working");
}

/** `task.update` — append touched files (deduped) and/or refine the title via `note`. */
export function taskUpdate(
  paneId: PaneId,
  agentId: AgentId,
  files?: string[],
  note?: string,
): void {
  const id = ensureActiveTask(paneId, agentId);
  if (files?.length) {
    setTasks(id, "files", (have) => {
      const seen = new Set(have);
      const add: string[] = [];
      for (const f of files) {
        if (f && !seen.has(f)) {
          seen.add(f); // dedup within this batch too, not just against stored files
          add.push(f);
        }
      }
      return add.length ? [...have, ...add] : have;
    });
  }
  const trimmed = note?.trim();
  if (trimmed) setTasks(id, "title", trimmed);
  persistTask(id);
}

/** `task.end` — finish the active Task; its Session goes idle. */
export function taskEnd(paneId: PaneId, outcome: TaskOutcome = "done"): void {
  const session = liveSession(paneId);
  if (!session) return;
  const active = activeTaskId(session);
  if (active) finishTask(active, outcome);
  setSessions(session.id, "state", "idle");
  persistSession(session.id);
}

/** `approval.request` — the active Task is now blocked on the user (the rich form of `attention`). */
export function approvalRequest(
  paneId: PaneId,
  agentId: AgentId,
  prompt: string,
  kind: ApprovalKind = "question",
): void {
  const id = ensureActiveTask(paneId, agentId);
  setTasks(id, "state", "blocked");
  setTasks(id, "approval", { prompt: prompt.trim(), kind });
  const sid = tasks[id].sessionId;
  setSessions(sid, "state", "blocked");
  persistTask(id);
  persistSession(sid);
}

/** `approval.resolve` — the agent signalled it's unblocked (or the user answered). */
export function approvalResolve(paneId: PaneId): void {
  const session = liveSession(paneId);
  if (!session) return;
  const active = activeTaskId(session);
  if (active == null || tasks[active].state !== "blocked") return;
  setTasks(active, "approval", "resolvedAt", now());
  setTasks(active, "state", "running");
  setSessions(session.id, "state", "running");
  persistTask(active);
  persistSession(session.id);
}

/** Drop all state — test isolation only (the store is module-scoped). */
export function resetSessions(): void {
  for (const k of Object.keys(sessions)) setSessions(k, undefined as unknown as Session);
  for (const k of Object.keys(tasks)) setTasks(k, undefined as unknown as Task);
  for (const k of Object.keys(livePane)) setLivePane(Number(k), undefined);
  synthSeq = 0;
}

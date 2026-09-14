import type { ApprovalRequest } from "./approvals.ts";
import type { HubEvent } from "./events.ts";
import type { ApprovalId, SessionId } from "./ids.ts";
import type { SessionState, SessionSummary } from "./session.ts";

/**
 * Current state derived from the event log (ADR-0003). The hub keeps one; clients keep their own
 * copy built from a snapshot plus live events. Both use these functions, so they cannot drift.
 */
export interface Projection {
  head: number;
  sessions: Map<SessionId, SessionSummary>;
  pending: Map<ApprovalId, ApprovalRequest>;
}

export function createProjection(): Projection {
  return { head: 0, sessions: new Map(), pending: new Map() };
}

const SUBTITLE_MAX = 80;
const ACTIVITY_MAX = 140;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolBrief(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.description;
  return typeof v === "string" ? `: ${v}` : "";
}

function subtitleFrom(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > SUBTITLE_MAX ? `${line.slice(0, SUBTITLE_MAX - 1)}…` : line;
}

function endedState(outcome: "done" | "error" | "stopped"): SessionState {
  return outcome === "error" ? "error" : "done";
}

/**
 * The next summary for one session after one event. Pure: returns a new object or the same one.
 * Unknown sessions stay unknown until their `session.created` arrives.
 */
export function reduceSummary(prev: SessionSummary | undefined, e: HubEvent): SessionSummary | undefined {
  const ev = e.event;
  if (ev.type === "session.created") return { ...ev.summary };
  if (!prev) return prev;

  const base = { ...prev, updatedAt: Math.max(prev.updatedAt, e.at) };
  switch (ev.type) {
    case "session.state": {
      const { blockedOn: _drop, ...rest } = base;
      return ev.state === "blocked" && ev.blockedOn
        ? { ...rest, state: ev.state, blockedOn: ev.blockedOn, stateProvenance: ev.provenance }
        : { ...rest, state: ev.state, stateProvenance: ev.provenance };
    }
    case "session.level":
      return { ...base, level: ev.level };
    case "session.engine":
      return {
        ...base,
        engineSessionId: ev.engineSessionId,
        ...(ev.model !== undefined ? { model: ev.model } : {}),
        ...(ev.loaded !== undefined ? { loaded: ev.loaded } : {}),
      };
    case "session.live":
      return { ...base, live: ev.live };
    case "session.process":
      return { ...base, command: ev.command, ...(ev.agent !== undefined ? { agent: ev.agent } : {}) };
    case "session.archived": {
      const worktree = base.worktree && ev.worktreeRemoved ? { ...base.worktree, removed: true } : base.worktree;
      return { ...base, archived: ev.archived, ...(worktree ? { worktree } : {}) };
    }
    case "assistant.text":
      return ev.parentToolUseId ? base : { ...base, activity: oneLine(ev.text, ACTIVITY_MAX) };
    case "tool.use":
      return ev.parentToolUseId ? base : { ...base, activity: oneLine(`${ev.toolName}${toolBrief(ev.input)}`, ACTIVITY_MAX) };
    case "error":
      return { ...base, activity: oneLine(ev.message, ACTIVITY_MAX) };
    case "speech":
      return { ...base, activity: oneLine(`“${ev.text}”`, ACTIVITY_MAX) };
    case "session.renamed":
      return { ...base, name: ev.name, ...(ev.subtitle !== undefined ? { subtitle: ev.subtitle } : {}) };
    case "session.ended": {
      const { blockedOn: _drop, ...rest } = base;
      return { ...rest, state: endedState(ev.outcome), stateProvenance: "hub", live: false };
    }
    case "user.message": {
      const withActivity = { ...base, activity: oneLine(ev.text, ACTIVITY_MAX) };
      return base.subtitle ? withActivity : { ...withActivity, subtitle: subtitleFrom(ev.text) };
    }
    case "cost.update":
      return { ...base, costUsd: ev.costUsd };
    case "files.changed":
      return { ...base, changedFiles: ev.files.length };
    case "terminal.exit":
      return { ...base, exitCode: ev.code };
    default:
      return base;
  }
}

/** Applies one event to a projection in place. */
export function applyEvent(p: Projection, e: HubEvent): void {
  p.head = Math.max(p.head, e.seq);

  const next = reduceSummary(p.sessions.get(e.sessionId), e);
  if (next) p.sessions.set(e.sessionId, next);

  const ev = e.event;
  if (ev.type === "approval.requested") p.pending.set(ev.request.id, ev.request);
  else if (ev.type === "approval.updated") {
    const req = p.pending.get(ev.approvalId);
    if (req) p.pending.set(ev.approvalId, { ...req, steward: ev.steward });
  }
  else if (ev.type === "approval.resolved") p.pending.delete(ev.approvalId);
  else if (ev.type === "session.ended") {
    for (const [id, req] of p.pending) if (req.sessionId === e.sessionId) p.pending.delete(id);
  }
}

import { z } from "zod";
import type { ApprovalRequest } from "./approvals.ts";
import { ApprovalDecision } from "./approvals.ts";
import type { HubEvent } from "./events.ts";
import { ApprovalId, Seq, SessionId } from "./ids.ts";
import { PermissionLevel } from "./levels.ts";
import type { PolicyView } from "./policy.ts";
import { PolicyFile, PolicyScope } from "./policy.ts";
import type { BoardView } from "./board.ts";
import { CardInput, CardStatus } from "./board.ts";
import type { SessionSummary } from "./session.ts";
import { SessionSpec, SessionState, UserMessageSource } from "./session.ts";
import { SpokenLanguage } from "./voice.ts";
import { type PushDevice, PushSubscriptionJson } from "./push.ts";
import type { SessionDiff } from "./diff.ts";

/**
 * Client → hub commands (ADR-0008). Each gets exactly one response frame.
 * The same commands back the `loom` CLI and the Cockpit's MCP tools, so every capability
 * exists once.
 */
export const Command = z.discriminatedUnion("cmd", [
  /**
   * Sessions, pending approvals, and the log head, taken atomically. A client applies the
   * snapshot, then subscribes with `since: head`, and misses nothing.
   */
  z.object({ cmd: z.literal("hub.snapshot") }),
  z.object({ cmd: z.literal("session.list") }),
  z.object({ cmd: z.literal("session.create"), spec: SessionSpec }),
  z.object({
    cmd: z.literal("session.send"),
    sessionId: SessionId,
    text: z.string().min(1),
    from: UserMessageSource.optional(),
  }),
  z.object({ cmd: z.literal("session.interrupt"), sessionId: SessionId }),
  z.object({ cmd: z.literal("session.stop"), sessionId: SessionId }),
  z.object({ cmd: z.literal("session.rename"), sessionId: SessionId, name: z.string().trim().min(1).max(40) }),
  /**
   * Hide a session and stop it. With `removeWorktree`, also delete its worktree directory, refusing if it
   * has uncommitted changes unless `force`. The branch is never deleted.
   */
  z.object({
    cmd: z.literal("session.archive"),
    sessionId: SessionId,
    removeWorktree: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("session.unarchive"), sessionId: SessionId }),
  /** Who the caller is: a person with the hub token, or a session with its own token. */
  z.object({ cmd: z.literal("hub.whoami") }),
  /** Resolves when the session is in one of `states`, or at the timeout with its current state. */
  z.object({
    cmd: z.literal("session.wait"),
    sessionId: SessionId,
    states: z.array(SessionState).min(1),
    timeoutMs: z.number().int().min(1).max(600_000),
  }),
  /** Shared notes per project, in memory: coordination state for sessions (v1 blackboard). */
  z.object({ cmd: z.literal("notes.set"), cwd: z.string().min(1), key: z.string().trim().min(1).max(200), value: z.string().max(20_000) }),
  z.object({ cmd: z.literal("notes.get"), cwd: z.string().min(1), key: z.string().min(1) }),
  z.object({ cmd: z.literal("notes.list"), cwd: z.string().min(1) }),
  z.object({ cmd: z.literal("notes.delete"), cwd: z.string().min(1), key: z.string().min(1) }),
  /** Advisory file claims per project, in memory: a session says it is working on a path. */
  z.object({ cmd: z.literal("claims.claim"), cwd: z.string().min(1), path: z.string().min(1), note: z.string().max(500).optional() }),
  z.object({ cmd: z.literal("claims.release"), cwd: z.string().min(1), path: z.string().min(1), force: z.boolean().optional() }),
  z.object({ cmd: z.literal("claims.list"), cwd: z.string().min(1) }),
  /** Cost today (hub local time), total cost, and sessions by state. */
  z.object({ cmd: z.literal("hub.stats") }),
  /**
   * Speech to text on this hub. `audio` is base64 of a WAV file: PCM, 16-bit, mono, 16 kHz, at most
   * five minutes. Without `language`, English or Portuguese is chosen per clip.
   */
  z.object({
    cmd: z.literal("voice.transcribe"),
    audio: z.string().min(1).max(14_000_000),
    language: SpokenLanguage.optional(),
    /** Words to expect, e.g. "Allow. Deny." while approvals are open; helps with one-word clips. */
    prompt: z.string().max(300).optional(),
  }),
  /** Text to speech with this hub's engine. Without `lang`, the language is detected from the text. */
  z.object({ cmd: z.literal("voice.speak"), text: z.string().min(1).max(4000), lang: SpokenLanguage.optional() }),
  /** What a session changed, from git: uncommitted work, or a worktree branch against its base. */
  z.object({ cmd: z.literal("session.diff"), sessionId: SessionId, mode: z.enum(["uncommitted", "branch"]).optional() }),
  /**
   * Undo uncommitted changes in a session's folder: one hunk (by the id the person saw) or a whole file.
   * People only, and not while the session is working.
   */
  z.object({ cmd: z.literal("session.revert"), sessionId: SessionId, path: z.string().min(1).max(4096), hunkId: z.string().min(1).max(64).optional() }),
  /** Words in session history, newest first: messages, replies, tool calls, approvals, speech, errors. */
  z.object({ cmd: z.literal("history.search"), query: z.string().min(1).max(200), sessionId: SessionId.optional(), limit: z.number().int().min(1).max(200).optional() }),
  /** This hub's VAPID public key, for `pushManager.subscribe`. */
  z.object({ cmd: z.literal("push.key") }),
  /** Register this device for push notifications; the same endpoint replaces its earlier registration. */
  z.object({ cmd: z.literal("push.subscribe"), subscription: PushSubscriptionJson, label: z.string().min(1).max(80) }),
  z.object({ cmd: z.literal("push.unsubscribe"), endpoint: z.string().url().max(2000) }),
  /** Send a test notification to one device, or to all. */
  z.object({ cmd: z.literal("push.test"), endpoint: z.string().url().max(2000).optional() }),
  z.object({ cmd: z.literal("push.devices") }),
  /** A session says something to the person, as a `speech` event. Sessions may only speak as themselves. */
  z.object({ cmd: z.literal("session.speak"), sessionId: SessionId, text: z.string().min(1).max(2000), lang: SpokenLanguage.optional() }),
  /** Start the engine again: relaunch an ended terminal, or resume a paused chat session. */
  z.object({ cmd: z.literal("session.restart"), sessionId: SessionId }),
  /**
   * Continue a chat session in its engine's own terminal UI. Stops the chat engine and creates a
   * linked terminal session. Returns the new session.
   */
  z.object({ cmd: z.literal("session.open-terminal"), sessionId: SessionId }),
  z.object({ cmd: z.literal("session.set-level"), sessionId: SessionId, level: PermissionLevel }),
  /** Read a session's history from the log. `since` is exclusive. */
  z.object({
    cmd: z.literal("session.read"),
    sessionId: SessionId,
    since: Seq.optional(),
    limit: z.number().int().positive().max(5000).optional(),
  }),
  /** Start streaming events. `since` replays everything after that seq first. */
  z.object({
    cmd: z.literal("events.subscribe"),
    since: Seq.optional(),
    sessionIds: z.array(SessionId).optional(),
  }),
  z.object({ cmd: z.literal("approval.list") }),
  /** The board for the project that contains `cwd`. Also subscribes this connection to its `board` frames. */
  z.object({ cmd: z.literal("board.get"), cwd: z.string().min(1) }),
  z.object({ cmd: z.literal("board.add"), cwd: z.string().min(1), card: CardInput }),
  z.object({ cmd: z.literal("board.update"), cwd: z.string().min(1), cardId: z.string().min(1), card: CardInput }),
  z.object({ cmd: z.literal("board.move"), cwd: z.string().min(1), cardId: z.string().min(1), status: CardStatus }),
  z.object({ cmd: z.literal("board.remove"), cwd: z.string().min(1), cardId: z.string().min(1) }),
  /** Start a session for a to-do card. Returns the session. */
  z.object({ cmd: z.literal("board.dispatch"), cwd: z.string().min(1), cardId: z.string().min(1) }),
  /** Keep up to `cap` cards running, taking to-do cards in order; `null` stops. In memory only. */
  z.object({ cmd: z.literal("board.run"), cwd: z.string().min(1), cap: z.number().int().min(1).max(20).nullable() }),
  /** Hub policy and the project policy that applies to `cwd`. */
  z.object({ cmd: z.literal("policy.get"), cwd: z.string().min(1) }),
  /** Replace a policy file. Saving a project policy trusts its allow list, since a person wrote it here. */
  z.object({ cmd: z.literal("policy.save"), scope: PolicyScope, cwd: z.string().min(1), policy: PolicyFile }),
  /** Trust the project allow list that hashes to `allowHash`; fails if the file changed since it was shown. */
  z.object({ cmd: z.literal("policy.trust"), cwd: z.string().min(1), allowHash: z.string().min(1) }),
  z.object({ cmd: z.literal("approval.decide"), approvalId: ApprovalId, decision: ApprovalDecision }),
  /** Reject an action the Steward allowed: lowers the session to Supervised and tells the agent. */
  z.object({ cmd: z.literal("approval.override"), approvalId: ApprovalId }),
  /**
   * Start receiving a terminal's output on this connection. Returns the recent screen as base64 with
   * the byte offset it starts at; `term` frames follow with later offsets.
   */
  z.object({ cmd: z.literal("terminal.attach"), sessionId: SessionId }),
  z.object({ cmd: z.literal("terminal.detach"), sessionId: SessionId }),
  /** pty adapter: keystrokes (base64) and size. */
  z.object({ cmd: z.literal("terminal.write"), sessionId: SessionId, data: z.string().max(1_000_000) }),
  z.object({
    cmd: z.literal("terminal.resize"),
    sessionId: SessionId,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandName = Command["cmd"];

export type Caller =
  | { kind: "human" }
  | { kind: "session"; sessionId: string; name: string; role: "session" | "cockpit"; cwd: string; projectRoot: string };

export interface Note {
  key: string;
  value: string;
  /** Session name, or "you" for a person. */
  by: string;
  at: number;
}

export interface Claim {
  path: string;
  /** Session id of the holder, or "human". */
  holder: string;
  holderName: string;
  note?: string;
  at: number;
}

export interface HubStats {
  costToday: number;
  costTotal: number;
  /** Spent on Steward reviews today, included in neither session cost nor costToday. */
  stewardCostToday: number;
  /** Non-archived sessions by state. */
  states: Record<string, number>;
  pendingApprovals: number;
}

/** One history search result. `snippet` marks matches between \u0001 and \u0002. */
export interface HistoryHit {
  seq: number;
  at: number;
  sessionId: string;
  sessionName: string;
  type: string;
  snippet: string;
}

/** What each command returns in a successful response's `data`. */
export interface CommandResults {
  "hub.snapshot": { head: number; sessions: SessionSummary[]; approvals: ApprovalRequest[] };
  "session.list": SessionSummary[];
  "session.create": SessionSummary;
  "session.send": void;
  "session.interrupt": void;
  "session.stop": void;
  "session.restart": void;
  "session.rename": void;
  "session.archive": void;
  "session.unarchive": void;
  "hub.stats": HubStats;
  "voice.transcribe": { text: string; language: SpokenLanguage; engine: string; audioMs: number; tookMs: number };
  "voice.speak": { audio: string; mime: string; lang: SpokenLanguage; engine: string };
  "session.speak": void;
  "history.search": HistoryHit[];
  "session.diff": SessionDiff;
  "session.revert": SessionDiff;
  "push.key": { publicKey: string };
  "push.subscribe": PushDevice;
  "push.unsubscribe": void;
  "push.test": { sent: number; failed: number };
  "push.devices": PushDevice[];
  "hub.whoami": Caller;
  "session.wait": SessionSummary;
  "notes.set": Note;
  "notes.get": Note | null;
  "notes.list": Note[];
  "notes.delete": void;
  "claims.claim": Claim;
  "claims.release": void;
  "claims.list": Claim[];
  "board.get": BoardView;
  "board.add": BoardView;
  "board.update": BoardView;
  "board.move": BoardView;
  "board.remove": BoardView;
  "board.dispatch": SessionSummary;
  "board.run": BoardView;
  "session.open-terminal": SessionSummary;
  "terminal.attach": { offset: number; data: string; live: boolean };
  "terminal.detach": void;
  "session.set-level": void;
  "session.read": HubEvent[];
  "events.subscribe": { head: number };
  "approval.list": ApprovalRequest[];
  "approval.decide": void;
  "approval.override": void;
  "policy.get": PolicyView;
  "policy.save": PolicyView;
  "policy.trust": PolicyView;
  "terminal.write": void;
  "terminal.resize": void;
}

/** The command variant for a given name. */
export type CommandOf<N extends CommandName> = Extract<Command, { cmd: N }>;

import { z } from "zod";
import { SessionId, Timestamp } from "./ids.ts";
import { PermissionLevel } from "./levels.ts";
import { ApprovalTimeout } from "./policy.ts";

/**
 * Which adapter runs a session (ADR-0004). The core never branches on a CLI's name; only
 * adapters and detection manifests know them.
 */
export const AdapterKind = z.enum(["claude-sdk", "pty"]);
export type AdapterKind = z.infer<typeof AdapterKind>;

/**
 * Semantic session state, herdr's vocabulary (ADR-0004).
 *
 * - `starting` spawned, no first frame yet
 * - `working`  the engine is producing output or running tools
 * - `blocked`  waiting on something outside the engine; see `BlockedOn`
 * - `idle`     turn finished, waiting for the next user message
 * - `done`     session ended normally
 * - `error`    session ended abnormally
 */
export const SessionState = z.enum(["starting", "working", "blocked", "idle", "done", "error"]);
export type SessionState = z.infer<typeof SessionState>;

/** Why a session is blocked. Carried alongside `state: "blocked"`. */
export const BlockedOn = z.enum(["approval", "question", "input"]);
export type BlockedOn = z.infer<typeof BlockedOn>;

/**
 * Where a signal came from, strongest first (v1 provenance ladder, ADR-0011).
 * `hub` is a fact the hub itself established, e.g. "this session's process is not running".
 */
export const Provenance = z.enum(["pushed", "hub", "kernel", "heuristic"]);
export type Provenance = z.infer<typeof Provenance>;

/** Who sent a user message into a session. */
export const UserMessageSource = z.enum(["human", "cockpit", "session", "card", "voice"]);
export type UserMessageSource = z.infer<typeof UserMessageSource>;

/** Request to create a session. */
export const SessionSpec = z.object({
  adapter: AdapterKind,
  /** Absolute working directory on the hub machine. */
  cwd: z.string().min(1),
  /**
   * Run in a git worktree on `branch`. The branch is created from `baseRef` (default: the repository's
   * HEAD) unless it already exists. Off unless asked (decision 8).
   */
  worktree: z.object({ branch: z.string().min(1).max(200), baseRef: z.string().min(1).optional() }).optional(),
  level: PermissionLevel.optional(),
  /** Model id for structured adapters, e.g. "claude-opus-5". Absent = engine default. */
  model: z.string().min(1).optional(),
  /** First user message, sent as soon as the session starts. */
  prompt: z.string().optional(),
  /** Role suffix appended to the system prompt (builder, reviewer, …). Free-form. */
  role: z.string().min(1).optional(),
  /** Resume an engine session instead of starting fresh. */
  resumeEngineSessionId: z.string().min(1).optional(),
  /** pty adapter only: the command line to run. Absent = login shell. */
  command: z.string().min(1).optional(),
  /**
   * pty adapter only: run a known agent's own terminal UI with its integration (hooks) instead of a
   * plain command. Adapters decide which names they know; the core only passes it through.
   */
  agent: z.string().min(1).optional(),
  /** The session this one continues, e.g. a chat session opened in a terminal. */
  linkedSessionId: z.string().min(1).optional(),
  /** The hub's Cockpit: a Claude chat session with tools over every other session (ADR-0007). One per hub. */
  cockpit: z.boolean().optional(),
  /** Deny approvals nobody decides within this time. Overrides project and hub policy. */
  approvalTimeout: ApprovalTimeout.optional(),
  /** Initial terminal size. The first client to attach resizes it. */
  terminal: z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(500) }).optional(),
  /** Board card this session works on, if dispatched from one. */
  cardId: z.string().min(1).optional(),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

/** Extensions the engine loaded for a session, shown so nothing runs invisibly (ADR-0005). */
export const EngineLoaded = z.object({
  plugins: z.array(z.string()),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
});
export type EngineLoaded = z.infer<typeof EngineLoaded>;

/** A session's git worktree. */
export const WorktreeInfo = z.object({
  path: z.string(),
  /** The main repository the worktree belongs to. */
  repoRoot: z.string(),
  branch: z.string(),
  baseRef: z.string().optional(),
  /** The commit the branch started from, for "changes on this branch". */
  baseCommit: z.string().optional(),
  /** True once the worktree directory was removed (the branch is kept). */
  removed: z.boolean().optional(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfo>;

/** What a client needs to render a session in the rail and overview. A projection of the event log. */
export const SessionSummary = z.object({
  id: SessionId,
  /** Stable handle from the name pool, e.g. "faye". Used by `loom send faye`. */
  name: z.string().min(1),
  /** Card title or first prompt, shortened. */
  subtitle: z.string().optional(),
  adapter: AdapterKind,
  cwd: z.string(),
  /** The project this session belongs to: the main repository root for worktrees, used for grouping, policy, and the board. */
  projectRoot: z.string(),
  branch: z.string().optional(),
  worktree: WorktreeInfo.optional(),
  /** The board card this session works on. */
  cardId: z.string().optional(),
  /** Hidden from the rail. */
  archived: z.boolean(),
  /** One line about the latest thing the session did, for the overview. */
  activity: z.string().optional(),
  state: SessionState,
  blockedOn: BlockedOn.optional(),
  stateProvenance: Provenance,
  level: PermissionLevel,
  model: z.string().optional(),
  /** The engine's own session id, e.g. Claude's UUID, used for resume and "open as terminal". */
  engineSessionId: z.string().optional(),
  loaded: EngineLoaded.optional(),
  /**
   * Whether the engine process is running. A session that is not live is still resumable;
   * sending to it starts the engine again with its engineSessionId.
   */
  live: z.boolean(),
  /** Session total estimated spend in USD, across engine restarts. Informational on subscription plans. */
  costUsd: z.number().nonnegative(),
  /** Files changed at the end of the last turn, from `files.changed`. */
  changedFiles: z.number().int().nonnegative().optional(),
  pinned: z.boolean(),
  /** pty sessions: what is running, for display. */
  command: z.string().optional(),
  agent: z.string().optional(),
  linkedSessionId: z.string().optional(),
  /** pty sessions: exit code of the last run, once it has exited. */
  exitCode: z.number().int().optional(),
  /** True for the Cockpit session. At most one per hub. */
  cockpit: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// Shared IPC contract between the SolidJS frontend and the Rust PTY engine.
// The Rust command handlers in `src-tauri/src/lib.rs` mirror these names and shapes —
// this module is the single source of truth for both sides (CLAUDE.md: "Shared types
// in one module").

/**
 * Stable identity of a pane in the frontend layout tree. Allocated by the workspace
 * store (a monotonic counter), it survives splits/closes and is what the tree, focus,
 * naming, and zoom all key off.
 *
 * Note: this is distinct from {@link PtyHandle}, the id Rust assigns to a live PTY. A
 * pane component owns its PtyHandle internally (spawn/write/resize/kill); the rest of
 * the UI only ever deals in PaneId. The two need not share a value.
 */
export type PaneId = number;

/** Opaque handle to a live PTY, assigned by Rust on `pty_spawn`. Used only for IPC. */
export type PtyHandle = number;

/**
 * What to run in a pane. M1/M2 always spawn the login `$SHELL`; `command`/`cwd`/`env`
 * are honoured from M3 (persistence + the new-workspace wizard) onward. `title` is the
 * pane's display name (auto-assigned, user-renamable, persisted).
 */
export interface PaneSpec {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Shell to launch for this pane, overriding the global Default shell. May carry args, e.g.
   *  `wsl.exe -d Ubuntu` or `cmd.exe`. Omitted = use the global default (Settings → Default shell). */
  shell?: string;
  /** Managed Claude Code session id (a UUID) for conversation resume across app restarts. Pinned
   *  on this pane's first Claude launch via `--session-id`; later launches reattach via `--resume`
   *  so the conversation comes back (Claude persists it under ~/.claude — Loom never parses output;
   *  see lib/agents.ts `resumeClaudeCommand`). Absent for non-Claude panes or when resume is off. */
  sessionId?: string;
  title: string;
}

/**
 * A node in a workspace's binary split tree. A leaf binds a {@link PaneId}; a split lays
 * its two children side-by-side (`row`, vertical divider) or stacked (`col`, horizontal
 * divider), with `ratio` (0–1) the fraction given to child `a`.
 */
export type LayoutNode =
  | { kind: "leaf"; paneId: PaneId }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: LayoutNode; b: LayoutNode };

/** A named container: a working folder, one layout tree, and its panes. (Rail = M3.) */
export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  tree: LayoutNode;
  panes: Record<PaneId, PaneSpec>;
}

/** Tauri command names — spelled exactly once, here. */
export const Cmd = {
  spawn: "pty_spawn",
  write: "pty_write",
  resize: "pty_resize",
  kill: "pty_kill",
  cwd: "pty_cwd",
  /** Re-point a live pane's output/exit Channels at another window (tear-off / re-dock). */
  retarget: "pty_retarget",
  busy: "pty_busy",
  foreground: "pty_foreground",
  /** Batched title-bar poll: busy + foreground + cwd in one round-trip (see PaneMeta). */
  meta: "pty_meta",
  /** Advisory check that a command's program is installed/on PATH (wizard pre-flight). */
  checkCommand: "pty_check_command",
  /** List installed WSL distros for the new-workspace shell picker (empty off Windows). */
  wslDistros: "wsl_distros",
  /** Hand a relayed inter-pane request's answer back to Rust (ADR-0007). */
  paneCmdReply: "pane_cmd_reply",
} as const;

// ---- Inter-pane control bus (ADR-0007) -----------------------------------------------
// A process inside a pane (e.g. the `loom` CLI) sends one of these requests over the unix
// socket; Rust relays the raw string to the webview as a `ControlEvent`; the frontend
// (src/lib/paneControl.ts) parses it, acts, and replies. Rust never parses the protocol —
// this module is the only place it's defined.

/** The Tauri event Rust emits for each inbound request. */
export const PANE_CMD_EVENT = "loom://pane-cmd";

/** Event Rust emits when a pane's session-log write fails mid-stream (disk full, file removed).
 *  The owning pane matches `id` to its live PtyHandle and drops its "recording" indicator —
 *  without it a broken log would keep claiming to record. Carries the OS error for the tooltip. */
export const LOG_ERROR_EVENT = "loom://log-error";
export interface LogErrorEvent {
  /** The PtyHandle whose session log broke. */
  id: PtyHandle;
  error: string;
}

/** Event payload: an opaque request line + the id the reply must echo back. */
export interface ControlEvent {
  reqId: number;
  request: string;
}

/** Requests the `loom` CLI can make. `target`/`name` are pane display titles (e.g. "Cleo"). */
export type ControlRequest =
  | { op: "list" }
  | { op: "send"; target: string; text: string; enter?: boolean }
  | { op: "spawn"; command: string; name?: string; cwd?: string }
  // Read the tail of a pane's scrollback (so an agent can consume another pane's output). An
  // explicit, requested inbound read — distinct from ADR-0001's ban on Loom itself parsing
  // pane output for product logic; nothing here drives the UI off the content.
  | { op: "read"; target: string; lines?: number }
  // Broadcast text to every live pane in a workspace (the active one, or one named explicitly).
  | { op: "broadcast"; text: string; enter?: boolean; workspace?: string }
  // Reveal + focus a pane by name (switching to its workspace).
  | { op: "focus"; target: string }
  // Raise (or, with clear, drop) a pane's "needs you" attention border — a UI metadata flag,
  // never tied to pane output. Lets an agent flag itself when it's blocked on your input.
  | { op: "attention"; target: string; clear?: boolean }
  // Set (or, with no/empty text, clear) a pane's short status label, shown in its title bar and
  // overview tile. Same opacity-safe category as `attention`: the agent *pushes* the label; we
  // never read it from output. Turns overview mode into a fleet dashboard (building/blocked/idle).
  | { op: "status"; target: string; text?: string }
  // ---- Shared blackboard (docs/AGENTIC-ENHANCEMENTS.md §2b) ----
  // A workspace-scoped key/value board agents post plan state to and poll ("plan.api → Cleo",
  // discovered gotchas, who-owns-what). Pull-based coordination, opacity-safe: the value is agent-
  // pushed, never read from output. Scoped to the caller pane's workspace (`pane`), or an explicit
  // `workspace`; `pane` is also recorded as the writer on set. Ephemeral (runtime coordination
  // state, not persisted — same category as the activity store).
  | { op: "note.set"; key: string; value: string; pane?: string; workspace?: string }
  | { op: "note.get"; key: string; pane?: string; workspace?: string }
  | { op: "note.list"; pane?: string; workspace?: string }
  | { op: "note.del"; key: string; pane?: string; workspace?: string }
  // ---- Agent lifecycle (ADR-0008) ----
  // The rich form of attention/status: an agent reports its own Session/Task lifecycle, pushed
  // (via `loom hooks` / the MCP server), never parsed from output. `target` is the calling pane.
  // A pane has at most one Live Session; task/approval ops act on that session's current Task,
  // lazily creating a Session/Task if an agent emits work before a start signal.
  | { op: "session.start"; target: string; agent?: AgentId; sessionId?: string; cwd?: string }
  | { op: "session.end"; target: string; outcome?: TaskOutcome }
  | { op: "task.begin"; target: string; title: string }
  | { op: "task.update"; target: string; files?: string[]; note?: string }
  | { op: "task.end"; target: string; outcome?: TaskOutcome }
  | { op: "approval.request"; target: string; prompt: string; kind?: ApprovalKind }
  | { op: "approval.resolve"; target: string };

/** One pane in a `list` response. */
export interface PaneInfo {
  name: string;
  workspace: string;
  focused: boolean;
  live: boolean;
}

/** Uniform reply shape. `data` is op-specific (PaneInfo[] for list, {count}/{name}…). */
export type ControlResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

/**
 * Child-exit code delivered over a pane's `on_exit` Channel when its process dies
 * (on its own or via `pty_kill`). `-1` means the exit status was unavailable.
 */
export type ExitCode = number;

/**
 * Batched title-bar metadata returned by {@link Cmd.meta} — the Terminal poll's busy-state,
 * foreground command, and cwd in one read (mirrors Rust's `PaneMeta`). Each field is
 * independently `null` when unknown, matching the standalone `pty_busy`/`pty_foreground`/`pty_cwd`
 * commands it replaces for that poll. Process metadata, never pane output (ADR-0001 carve-out).
 */
export interface PaneMeta {
  busy: boolean | null;
  foreground: string | null;
  cwd: string | null;
}

// ---- Agent-awareness domain model (ADR-0008) -----------------------------------------
// Agents become first-class entities fed by agent-pushed signals (hooks / the MCP server) and
// the kernel floor — never by parsing pane output. `Agent` is the *kind* (registry); `Session`
// is one *run* of an Agent in a Pane; `Task` is a unit of work within a Session; `Approval` is
// the payload a Task carries while blocked on the user (not a standalone entity). Product state,
// so it lives here in TS (stores/sessions.ts), not Rust.

/** Identity of an Agent *kind* (Claude Code, Codex…). Resolves a registry entry (lib/agents.ts). */
export type AgentId = string;
/** Identity of one Session — the agent's own session id when it provides one, else synthesised. */
export type SessionId = string;
/** Identity of one Task (always synthesised; agents don't name tasks stably). */
export type TaskId = string;

/** How a Session or Task finished. */
export type TaskOutcome = "done" | "failed";
/** A live Session's coarse state. `blocked` = its current Task is waiting on the user. */
export type SessionState = "running" | "idle" | "blocked" | "done" | "failed";
/** A Task's state. `blocked` carries an {@link Approval}. */
export type TaskState = "running" | "blocked" | "done" | "failed";
/** What kind of thing the user is being asked, when a Task blocks. */
export type ApprovalKind = "permission" | "question" | "choice";

/** The structured "needs you" a Task carries while blocked — the rich form of the `attention` flag. */
export interface Approval {
  /** The agent's actual prompt, e.g. "Run `rm -rf build`?". Pushed by the agent, never scraped. */
  prompt: string;
  kind: ApprovalKind;
  /** Set when the agent signals it's unblocked (or the user answers). */
  resolvedAt?: number;
}

/** A unit of work an Agent reports doing within a Session (granularity the agent's to set). */
export interface Task {
  id: TaskId;
  sessionId: SessionId;
  /** Agent-pushed (a prompt, or a declared title); never inferred from output. */
  title: string;
  state: TaskState;
  startedAt: number;
  endedAt?: number;
  /** Paths the agent says it touched (→ interactive git review). Agent-pushed only. */
  files: string[];
  /** Present while `state === "blocked"`. */
  approval?: Approval;
}

/** One run of an Agent inside a Pane, over time. The durable unit fleet view / log key off. */
export interface Session {
  id: SessionId;
  /** Which Pane it ran in. The record may outlive the Pane (history). */
  paneId: PaneId;
  agentId: AgentId;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: SessionState;
  /** Its Tasks, oldest-first. */
  taskIds: TaskId[];
}

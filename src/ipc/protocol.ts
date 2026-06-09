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
  busy: "pty_busy",
  /** Hand a relayed inter-pane request's answer back to Rust (ADR-0007). */
  paneCmdReply: "pane_cmd_reply",
} as const;

// ---- Inter-pane control bus (ADR-0007) -----------------------------------------------
// A process inside a pane (e.g. the `th` CLI) sends one of these requests over the unix
// socket; Rust relays the raw string to the webview as a `ControlEvent`; the frontend
// (src/lib/paneControl.ts) parses it, acts, and replies. Rust never parses the protocol —
// this module is the only place it's defined.

/** The Tauri event Rust emits for each inbound request. */
export const PANE_CMD_EVENT = "termhaus://pane-cmd";

/** Event payload: an opaque request line + the id the reply must echo back. */
export interface ControlEvent {
  reqId: number;
  request: string;
}

/** Requests the `th` CLI can make. `target`/`name` are pane display titles (e.g. "Cleo"). */
export type ControlRequest =
  | { op: "list" }
  | { op: "send"; target: string; text: string; enter?: boolean }
  | { op: "spawn"; command: string; name?: string; cwd?: string }
  // Read the tail of a pane's scrollback (so an agent can consume another pane's output). An
  // explicit, requested inbound read — distinct from ADR-0001's ban on Termhaus itself parsing
  // pane output for product logic; nothing here drives the UI off the content.
  | { op: "read"; target: string; lines?: number }
  // Broadcast text to every live pane in a workspace (the active one, or one named explicitly).
  | { op: "broadcast"; text: string; enter?: boolean; workspace?: string }
  // Reveal + focus a pane by name (switching to its workspace).
  | { op: "focus"; target: string };

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

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
} as const;

/**
 * Child-exit code delivered over a pane's `on_exit` Channel when its process dies
 * (on its own or via `pty_kill`). `-1` means the exit status was unavailable.
 */
export type ExitCode = number;

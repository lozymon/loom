// Client for the "open any Claude session" picker — a thin invoke wrapper over the Rust command
// that enumerates past Claude conversations on disk (src-tauri/src/claude.rs). Read-only discovery
// of another tool's own session store; opening one relaunches it in a fresh pane via `claude
// --resume <id>` (see openClaudeSession in stores/workspace.ts).

import { invoke } from "@tauri-apps/api/core";

/** One resumable Claude conversation (mirrors Rust `ClaudeSession`). */
export interface ClaudeSession {
  /** Session id — feed to `claude --resume`. */
  id: string;
  /** Working folder the session ran in. */
  cwd: string;
  /** Short title (first user prompt), or "" if none. */
  title: string;
  /** Seconds since the Unix epoch of last modification (for sorting/display). */
  modified: number;
}

/** List resumable Claude sessions, newest first. Best-effort: a failure (no `~/.claude`, or off a
 *  desktop build) yields an empty list rather than throwing into the UI. */
export async function listClaudeSessions(): Promise<ClaudeSession[]> {
  try {
    return await invoke<ClaudeSession[]>("list_claude_sessions");
  } catch (e) {
    console.error("list_claude_sessions failed", e);
    return [];
  }
}

/** Whether a conversation transcript exists for `id` — so the launcher resumes only a session that
 *  was actually conversed in (a pinned-but-empty id has no file). Best-effort: errors → false. */
export async function claudeSessionExists(id: string): Promise<boolean> {
  try {
    return await invoke<boolean>("claude_session_exists", { sessionId: id });
  } catch (e) {
    console.error("claude_session_exists failed", e);
    return false;
  }
}

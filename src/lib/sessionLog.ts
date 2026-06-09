// Resolve a stable per-pane session-log path. Logging is opt-in (settings.sessionLogging);
// when on, each pane appends its raw output to <app config>/logs/<workspace>-<pane>-<id>.log.
// The same pane keeps the same file across respawns/restarts (append), so a pane's history
// accumulates in one place. Rust (workspace::session_log_path) owns making the dir + path safe.

import { invoke } from "@tauri-apps/api/core";
import type { PaneId } from "../ipc/protocol";

/**
 * Absolute log file path for a pane, or null if it can't be resolved. `wsName`/`title` only
 * shape the filename (sanitised in Rust); `paneId` keeps it unique within a workspace.
 */
export async function sessionLogPath(wsName: string, title: string, paneId: PaneId): Promise<string | null> {
  try {
    const name = `${wsName || "ws"}-${title || "pane"}-${paneId}`;
    return await invoke<string>("session_log_path", { name });
  } catch (e) {
    console.error("could not resolve session log path", e);
    return null;
  }
}

// Client for the durable Session/Task history (ADR-0009) — thin invoke wrappers over the Rust
// SQLite commands (src-tauri/src/sessionlog.rs). The in-memory store (stores/sessions.ts) stays the
// live source of truth; these mirror it to disk and back it with cross-session search.
//
// We pass whole Session/Task objects; Rust deserializes only the columns it stores (extra fields
// like `taskIds`/`approval.resolvedAt` are ignored). All writes are best-effort and fire-and-forget
// from the store's perspective — a failed persist must never disrupt the live UI.

import { invoke } from "@tauri-apps/api/core";
import type { Session, Task } from "../ipc/protocol";

/** A search / recent-history hit: a task joined with its session's agent + cwd (see Rust `TaskHit`). */
export interface TaskHit {
  taskId: string;
  sessionId: string;
  agentId: string;
  cwd: string;
  title: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  files: string[];
}

export const saveSession = (session: Session): Promise<void> =>
  invoke<void>("session_log_save_session", { session });

export const saveTask = (task: Task): Promise<void> =>
  invoke<void>("session_log_save_task", { task });

/** Cross-session substring search over task titles + approval prompts (newest first). */
export const searchTasks = (query: string, limit?: number): Promise<TaskHit[]> =>
  invoke<TaskHit[]>("session_log_search", { query, limit });

/** Recent task history across all sessions (newest first). */
export const recentTasks = (limit?: number): Promise<TaskHit[]> =>
  invoke<TaskHit[]>("session_log_recent", { limit });

/** Prune the history to the configured bounded window (ADR-0009); a cap of 0 disables it. */
export const pruneHistory = (maxAgeDays: number, maxSessions: number): Promise<void> =>
  invoke<void>("session_log_prune", { maxAgeDays, maxSessions });

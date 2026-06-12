// Client for the read-only session-log commands (src-tauri/src/logs.rs): list the opt-in per-pane
// logs and tail-read one. The SessionLogViewer renders the (ANSI-stripped) tail.

import { invoke } from "@tauri-apps/api/core";

/** One session-log file (see Rust `LogEntry`). */
export interface LogEntry {
  name: string;
  path: string;
  size: number;
  /** Whole seconds since the Unix epoch (0 if unavailable). */
  modified: number;
}

/** The tail of a log (see Rust `LogTail`). */
export interface LogTail {
  text: string;
  truncated: boolean;
  size: number;
}

/** List the `*.log` files under the app's logs dir, newest-modified first. */
export const listLogs = (): Promise<LogEntry[]> => invoke<LogEntry[]>("list_logs");

/** Read the last `maxBytes` of a log file (lossily decoded). */
export const readLogTail = (path: string, maxBytes: number): Promise<LogTail> =>
  invoke<LogTail>("read_log_tail", { path, maxBytes });

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

/** Write an exported markdown transcript to a user-chosen path (from the save dialog). */
export const exportMarkdown = (path: string, content: string): Promise<void> =>
  invoke("export_markdown", { path, content });

/** Format a session log as a shareable markdown transcript (AGENTIC §3b): a titled header with the
 *  pane/size, then the (ANSI-stripped) output in a fenced block so it pastes cleanly into a PR/doc. */
export function logToMarkdown(entry: { name: string; size: number }, content: string): string {
  const kb = entry.size < 1024 ? `${entry.size} B` : `${(entry.size / 1024).toFixed(1)} KB`;
  return `# Session transcript — ${entry.name}\n\n_${kb} · exported from Loom_\n\n\`\`\`text\n${content.replace(/```/g, "ʼʼʼ")}\n\`\`\`\n`;
}

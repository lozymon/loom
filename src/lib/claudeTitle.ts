// Client for a Claude pane's current-work label (its transcript's latest aiTitle + current tool),
// read by the Rust `claude_title` command from the agent's own on-disk transcript — never pane
// output (opacity-safe, ADR-0001). Fills the overview caption for a hookless agent, which pushes no
// Task and so has no title otherwise. Sibling of lib/claudeUsage.ts (which reads the same store for
// tokens); this reads it for "what is the agent doing".

import { invoke } from "@tauri-apps/api/core";

/** Mirrors Rust `TranscriptLabel`. Either field may be null when not found. */
export interface TranscriptLabel {
  title: string | null;
  tool: string | null;
}

/** The current-work label for a Claude session, or null when there's no transcript / nothing to
 *  show. Best-effort: any failure yields null rather than throwing into the poll. */
export async function claudeTitle(sessionId: string): Promise<TranscriptLabel | null> {
  try {
    return await invoke<TranscriptLabel | null>("claude_title", { sessionId });
  } catch (e) {
    console.error("claude_title failed", e);
    return null;
  }
}

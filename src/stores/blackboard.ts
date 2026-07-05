// Shared blackboard — a per-workspace key/value board panes post plan state to and poll
// (docs/AGENTIC-ENHANCEMENTS.md §2b). It's the coordination surface a fleet uses to agree who
// owns what, record a discovered gotcha, or hand off a decision, without ever parsing pane output
// (ADR-0001): every value is *pushed* over the control bus (`loom note …`, ADR-0007).
//
// Scope is the workspace id — one board per workspace, matching Loom's two-level mental model.
// State is ephemeral (not persisted): it's live coordination state, the same category as the
// activity store — respawning is a fresh start, not a restore (the "persist intent, not runtime
// state" rule). Keyed board[workspaceId][key] = { value, by, at }.

import { createStore } from "solid-js/store";

export interface NoteEntry {
  /** The value the writer posted (opaque text — Loom never interprets it). */
  value: string;
  /** Display name of the pane that last wrote this key ("?" if unknown). */
  by: string;
  /** Epoch-ms of that write — lets the UI/CLI show "who, and how stale". */
  at: number;
}

/** One key + its entry, for `note.list` output. */
export interface NoteListing extends NoteEntry {
  key: string;
}

const [board, setBoard] = createStore<Record<string, Record<string, NoteEntry>>>({});

/** Reactive read-only view — read `board[wsId]?.[key]?.value` etc. */
export { board };

/** Post (or overwrite) a key on a workspace's board. `by` is the writer pane's display name. */
export function noteSet(wsId: string, key: string, value: string, by: string) {
  if (!board[wsId]) setBoard(wsId, {});
  setBoard(wsId, key, { value, by, at: Date.now() });
}

/** Read one entry; undefined if the key isn't set. */
export function noteGet(wsId: string, key: string): NoteEntry | undefined {
  return board[wsId]?.[key];
}

/** The whole board for a workspace, key-sorted for stable output. */
export function noteList(wsId: string): NoteListing[] {
  const b = board[wsId];
  if (!b) return [];
  return Object.keys(b)
    .sort()
    .map((key) => ({ key, ...b[key] }));
}

/** Remove one key. Returns false if it wasn't set. */
export function noteDel(wsId: string, key: string): boolean {
  if (!board[wsId] || !(key in board[wsId])) return false;
  setBoard(wsId, key, undefined as unknown as NoteEntry);
  return true;
}

/** Drop a whole workspace's board (on workspace close). */
export function forgetBoard(wsId: string) {
  if (board[wsId]) setBoard(wsId, undefined as unknown as Record<string, NoteEntry>);
}

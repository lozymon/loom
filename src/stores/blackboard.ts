// Shared blackboard — a key/value board panes post plan state to and poll (docs/AGENTIC-
// ENHANCEMENTS.md §2b). It's the coordination surface a fleet uses to agree who owns what, record a
// discovered gotcha, or hand off a decision, without ever parsing pane output (ADR-0001): every
// value is *pushed* over the control bus (`loom note …`, ADR-0007).
//
// **Durable + project-scoped** (ORCHESTRATION-IDEAS §4): keyed by the project *folder* (a workspace's
// cwd) and persisted to `<dir>/.loom/notes.json`, exactly like the task board (stores/board.ts). So
// notes travel with the repo, survive close/reopen, are shared by every workspace on that folder,
// and — the point — a *new* agent inherits what earlier ones learned instead of starting cold. Still
// explicit and agent-addressed, never an implicit scrape of output. A folderless workspace ("") keeps
// its board in memory only. Keyed board[dir][key] = { value, by, at }.

import { createStore } from "solid-js/store";
import { projectStateLoad, projectStateSave } from "../lib/persist";

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

// Keyed by project folder (a workspace's cwd). "" is never persisted (in-memory only).
const [board, setBoard] = createStore<Record<string, Record<string, NoteEntry>>>({});

/** Reactive read-only view — read `board[dir]?.[key]?.value` etc. */
export { board };

// ---- Project-scoped persistence (`<dir>/.loom/notes.json`) ---------------------------

const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

/** Load a project's blackboard from `.loom/notes.json` once (idempotent). "" (no folder) is a no-op
 *  — those boards live in memory only. Call before a read/write so an agent's note can't clobber
 *  persisted notes a panel never opened. */
export async function ensureNotesLoaded(dir: string): Promise<void> {
  if (!dir || loaded.has(dir)) return;
  const inflight = loading.get(dir);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const raw = await projectStateLoad(dir, "notes");
      const obj: Record<string, NoteEntry> = raw ? (JSON.parse(raw) as Record<string, NoteEntry>) : {};
      setBoard(dir, obj);
    } catch (e) {
      console.error("failed to load .loom notes", e);
      if (!board[dir]) setBoard(dir, {});
    }
    loaded.add(dir);
  })();
  loading.set(dir, p);
  return p;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounced write of a project's blackboard to `.loom/notes.json`. Guarded so a non-Tauri env
 *  (tests) or a vanished folder can't throw. "" (no folder) is skipped — in-memory only. */
function scheduleSave(dir: string): void {
  if (!dir) return;
  clearTimeout(saveTimers.get(dir));
  saveTimers.set(dir, setTimeout(() => {
    try {
      void projectStateSave(dir, "notes", JSON.stringify(board[dir] ?? {})).catch(() => {});
    } catch { /* no Tauri (tests) */ }
  }, 400));
}

// ---- Mutations ----------------------------------------------------------------------

/** Post (or overwrite) a key on a project's board. `by` is the writer pane's display name. */
export function noteSet(dir: string, key: string, value: string, by: string) {
  if (!board[dir]) setBoard(dir, {});
  setBoard(dir, key, { value, by, at: Date.now() });
  scheduleSave(dir);
}

/** Read one entry; undefined if the key isn't set. */
export function noteGet(dir: string, key: string): NoteEntry | undefined {
  return board[dir]?.[key];
}

/** The whole board for a project, key-sorted for stable output. */
export function noteList(dir: string): NoteListing[] {
  const b = board[dir];
  if (!b) return [];
  return Object.keys(b)
    .sort()
    .map((key) => ({ key, ...b[key] }));
}

/** Remove one key. Returns false if it wasn't set. */
export function noteDel(dir: string, key: string): boolean {
  if (!board[dir] || !(key in board[dir])) return false;
  setBoard(dir, key, undefined as unknown as NoteEntry);
  scheduleSave(dir);
  return true;
}

/** Drop a project's board from memory (tests / a folderless reset). Persisted notes on disk are
 *  untouched — the board is project-scoped now, so closing one workspace never erases a repo's
 *  shared notes; they reload from `.loom/notes.json` next time. */
export function forgetBoard(dir: string) {
  if (board[dir]) setBoard(dir, undefined as unknown as Record<string, NoteEntry>);
}

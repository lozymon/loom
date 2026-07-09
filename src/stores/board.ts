// Task board (ORCHESTRATION-IDEAS §1) — the operator's "intent" layer for driving a fleet. Each
// card is a unit of work: a launch spec (what agent to run) + a prompt. Dispatching a card spawns a
// pane from that spec, feeds it the prompt, and pins the card to that pane so its live Session/Task
// state (ADR-0008) drives the card back to done.
//
// Storage is *project-scoped*, keyed by the workspace's working folder: cards live in the project's
// own `.loom/board.json` (like VSCode's `.vscode/`), so they travel with the repo, can be committed
// and shared, survive closing/reopening a workspace on that folder, and can be read by agents. A
// workspace with no folder ("") keeps its board in memory only. Cards are also reachable/mutable by
// agents over the control bus (`loom card …`, ADR-0007) — see lib/paneControl.ts.

import { createStore } from "solid-js/store";
import { batch, createEffect, createRoot } from "solid-js";
import { projectStateLoad, projectStateSave } from "../lib/persist";
import { spawnPane } from "./workspace";
import { paneActiveTask } from "./sessions";
import { writeToPanes } from "../lib/paneRegistry";
import type { PaneId } from "../ipc/protocol";

/** A unit of work on the board. `status` is the coarse lane; the panel derives a live sub-state
 *  (working/needs-you/…) for dispatched cards from the pinned pane. */
export interface BoardCard {
  id: string;
  title: string;
  /** The instruction fed to the agent on dispatch (empty = spawn the agent, type it yourself). */
  prompt: string;
  /** What to launch: the agent command (e.g. "claude"). */
  command: string;
  status: "todo" | "dispatched" | "done" | "failed";
  /** The pane this card was dispatched into (set on dispatch) — the key its live status reads off. */
  paneId?: PaneId;
}

// Keyed by project folder (a workspace's cwd). "" is never persisted (in-memory only).
const [board, setBoard] = createStore<Record<string, BoardCard[]>>({});

/** Reactive read-only view — read `board[dir]` for a project folder's cards. */
export { board };

/** Auto-drain config, keyed by project folder (same key as `board`). When `on`, the drainer keeps
 *  the "In progress" lane filled to `cap` by pulling the top To-do cards — see the drain loop below.
 *  Session-only / in-memory: deliberately NOT persisted to `.loom/board.json`, so a repo can't ship
 *  "auto-drain ON" and spawn a fleet the moment a teammate opens it. */
export interface DrainConfig { on: boolean; cap: number }
const DEFAULT_CAP = 3;
const [drain, setDrainStore] = createStore<Record<string, DrainConfig>>({});

/** Reactive read-only view of drain config. Read `drainState(dir)` for a folder's current setting. */
export { drain };

/** A folder's drain config (defaults to off). */
export function drainState(dir: string): DrainConfig {
  return drain[dir] ?? { on: false, cap: DEFAULT_CAP };
}

/** Arm/disarm auto-drain for a project folder, optionally setting the concurrency cap (min 1).
 *  Turning it on (or bumping the cap) immediately fills open slots via the reactive drain loop.
 *  Works on the folderless ("") board too — same in-memory key the default workspace's cards use. */
export function setDrain(dir: string, on: boolean, cap?: number): void {
  const prev = drainState(dir);
  const next: DrainConfig = { on, cap: Math.max(1, Math.round(cap ?? prev.cap)) };
  setDrainStore(dir, next);
}

let cardSeq = 0;
const nextCardId = (): string => `card${++cardSeq}`;

/** After spawn, how long to wait before typing the prompt in — long enough for the agent to boot
 *  its input UI. A heuristic (Loom never reads the pane to know when it's ready; ADR-0001). */
const DISPATCH_PROMPT_DELAY_MS = 1500;

/** A project folder's cards (the raw array; the panel splits them into lanes). */
export function cards(dir: string): BoardCard[] {
  return board[dir] ?? [];
}

/** Pure slot arithmetic for the auto-drainer: given a folder's cards and a concurrency cap, return
 *  the top To-do cards that should be dispatched *now* to fill open In-progress slots. Occupancy is
 *  counted by status — a dispatched card holds its slot until it leaves the lane ("hold the slot"),
 *  which is what makes the drain effect converge (each dispatch shrinks the free slots). Exported so
 *  the convergence logic is unit-testable without spawning real panes. */
export function drainCandidates(list: BoardCard[], cap: number): BoardCard[] {
  const occupied = list.filter((c) => c.status === "dispatched").length;
  const slots = cap - occupied;
  if (slots <= 0) return [];
  return list.filter((c) => c.status === "todo").slice(0, slots);
}

// ---- Project-scoped persistence (`<dir>/.loom/board.json`) ---------------------------

const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

/** Load a project's board from `.loom/board.json` once (idempotent). Dispatched cards are reset to
 *  To-do on load — their panes don't survive across sessions. "" (no folder) is a no-op. */
export async function ensureBoardLoaded(dir: string): Promise<void> {
  if (!dir || loaded.has(dir)) return;
  const inflight = loading.get(dir);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const raw = await projectStateLoad(dir, "board");
      const list: BoardCard[] = raw ? (JSON.parse(raw) as BoardCard[]) : [];
      for (const c of list) {
        if (c.status === "dispatched") { c.status = "todo"; c.paneId = undefined; }
      }
      const ids = list.map((c) => parseInt(c.id.replace(/\D/g, ""), 10) || 0);
      if (ids.length) cardSeq = Math.max(cardSeq, ...ids);
      setBoard(dir, list);
    } catch (e) {
      console.error("failed to load .loom board", e);
      if (!board[dir]) setBoard(dir, []);
    }
    loaded.add(dir);
  })();
  loading.set(dir, p);
  return p;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounced write of a project's board to `.loom/board.json`. Guarded so a non-Tauri env (tests)
 *  or a vanished folder can't throw. "" (no folder) is skipped — in-memory only. */
function scheduleSave(dir: string): void {
  if (!dir) return;
  clearTimeout(saveTimers.get(dir));
  saveTimers.set(dir, setTimeout(() => {
    try {
      void projectStateSave(dir, "board", JSON.stringify(board[dir] ?? [])).catch(() => {});
    } catch { /* no Tauri (tests) */ }
  }, 400));
}

// ---- Mutations ----------------------------------------------------------------------

/** Add a To-do card to a project's board. Blank title is ignored. Returns the new card's id. */
export function addCard(dir: string, input: { title: string; prompt?: string; command?: string }): string | undefined {
  const title = input.title.trim();
  if (!title) return undefined;
  const card: BoardCard = {
    id: nextCardId(),
    title,
    prompt: (input.prompt ?? "").trim(),
    command: (input.command ?? "claude").trim() || "claude",
    status: "todo",
  };
  setBoard(dir, [...(board[dir] ?? []), card]);
  scheduleSave(dir);
  return card.id;
}

const cardIdx = (dir: string, id: string) => (board[dir] ?? []).findIndex((c) => c.id === id);

/** Edit a card's fields (title/prompt/command) in place. A blank title is ignored (keeps the old).
 *  Only affects a future dispatch — it doesn't touch a card that's already running in a pane. */
export function updateCard(dir: string, id: string, patch: { title?: string; prompt?: string; command?: string }): boolean {
  const i = cardIdx(dir, id);
  if (i < 0) return false;
  setBoard(dir, i, (c) => ({
    ...c,
    title: patch.title?.trim() || c.title,
    prompt: patch.prompt !== undefined ? patch.prompt.trim() : c.prompt,
    command: patch.command?.trim() || c.command,
  }));
  scheduleSave(dir);
  return true;
}

/** Remove a card. Returns false if it wasn't found. */
export function removeCard(dir: string, id: string): boolean {
  const list = board[dir];
  if (!list || !list.some((c) => c.id === id)) return false;
  setBoard(dir, list.filter((c) => c.id !== id));
  scheduleSave(dir);
  return true;
}

/** Set a card's lane explicitly (mark done, reset, or an agent's `loom card move`). */
export function setCardStatus(dir: string, id: string, status: BoardCard["status"]): boolean {
  const i = cardIdx(dir, id);
  if (i < 0) return false;
  setBoard(dir, i, "status", status);
  scheduleSave(dir);
  return true;
}

/** Send a card back to To-do (reopen a done/failed card, or clear a dead dispatch). Drops its pane
 *  pin — a future dispatch spawns a fresh pane. */
export function reopenCard(dir: string, id: string): boolean {
  const i = cardIdx(dir, id);
  if (i < 0) return false;
  setBoard(dir, i, (c) => ({ ...c, status: "todo", paneId: undefined }));
  scheduleSave(dir);
  return true;
}

/** Retry a card: reopen it to To-do and immediately dispatch a fresh pane from its spec. */
export function redispatchCard(dir: string, id: string): void {
  if (reopenCard(dir, id)) dispatchCard(dir, id);
}

/** Reorder `id` to sit just before/after `targetId` in the project's card array (drag-and-drop).
 *  Lanes are filtered views of this one array, so moving relative to a same-lane neighbour reorders
 *  within that lane. Returns false if either card is missing or they're the same. */
export function reorderCard(dir: string, id: string, targetId: string, place: "before" | "after"): boolean {
  const list = board[dir];
  if (!list || id === targetId) return false;
  const from = list.findIndex((c) => c.id === id);
  if (from < 0 || !list.some((c) => c.id === targetId)) return false;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  let insert = next.findIndex((c) => c.id === targetId);
  if (place === "after") insert += 1;
  next.splice(insert, 0, moved);
  setBoard(dir, next);
  scheduleSave(dir);
  return true;
}

/**
 * Dispatch a To-do card: spawn a pane from its launch spec in the active workspace, pin the card to
 * that pane, and (after a short boot delay) type the prompt in. No-op if the card isn't To-do or
 * the spawn fails.
 */
export function dispatchCard(dir: string, id: string): void {
  const i = cardIdx(dir, id);
  if (i < 0) return;
  const card = board[dir][i];
  if (card.status !== "todo") return;
  const r = spawnPane({ title: card.title, command: card.command, cwd: dir || undefined });
  if ("error" in r) return;
  setBoard(dir, i, (c) => ({ ...c, status: "dispatched", paneId: r.paneId }));
  scheduleSave(dir);
  if (card.prompt) {
    // Deliver the prompt once the agent has (probably) booted — the same path `loom send` uses, so
    // it works for any agent, not just Claude.
    setTimeout(() => writeToPanes([r.paneId], card.prompt + "\r"), DISPATCH_PROMPT_DELAY_MS);
  }
}

// ---- Headless board loops -----------------------------------------------------------
// These run at module scope (not in a component) so the board keeps flowing even when the panel is
// closed — the swarm should drain whether or not you're looking at it. Both are purely reactive off
// the stores (no polling): a store change re-runs them. In a non-Tauri env (tests) the boards start
// empty and drain stays off, so they no-op.

createRoot(() => {
  // Auto-move: when a dispatched card's pinned pane reports its Task done/failed (ADR-0008), drive
  // the card to its lane. Best-effort — only agents that push signals report a Task; a plain shell
  // or a non-reporting agent stays "In progress" (holding its drain slot) until marked done by hand.
  createEffect(() => {
    for (const dir of Object.keys(board)) {
      for (const c of board[dir] ?? []) {
        if (c.status !== "dispatched" || c.paneId == null) continue;
        const t = paneActiveTask(c.paneId);
        if (t?.state === "done") setCardStatus(dir, c.id, "done");
        else if (t?.state === "failed") setCardStatus(dir, c.id, "failed");
      }
    }
  });

  // Auto-drainer: for each folder with drain armed, keep the "In progress" lane filled to `cap` by
  // dispatching the top To-do cards. The slot count is by *status* (a dispatched card always occupies
  // a slot until it leaves the lane — "hold the slot") so the loop converges: each dispatch flips a
  // card todo→dispatched, shrinking the free slots, and the effect re-runs off that same store write.
  // When the auto-move effect above frees a slot (→ done/failed), a slot opens and the next card goes.
  createEffect(() => {
    for (const dir of Object.keys(drain)) {
      const cfg = drain[dir];
      if (!cfg?.on) continue;
      const next = drainCandidates(board[dir] ?? [], cfg.cap);
      if (next.length) batch(() => next.forEach((c) => dispatchCard(dir, c.id)));
    }
  });
});

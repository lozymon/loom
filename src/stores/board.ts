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
import { projectStateLoad, projectStateSave } from "../lib/persist";
import { spawnPane } from "./workspace";
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

let cardSeq = 0;
const nextCardId = (): string => `card${++cardSeq}`;

/** After spawn, how long to wait before typing the prompt in — long enough for the agent to boot
 *  its input UI. A heuristic (Loom never reads the pane to know when it's ready; ADR-0001). */
const DISPATCH_PROMPT_DELAY_MS = 1500;

/** A project folder's cards (the raw array; the panel splits them into lanes). */
export function cards(dir: string): BoardCard[] {
  return board[dir] ?? [];
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

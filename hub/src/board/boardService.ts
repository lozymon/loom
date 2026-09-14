import {
  type BoardFile,
  BoardFile as BoardFileSchema,
  type BoardView,
  type Card,
  CardInput,
  type CardStatus,
  type HubEvent,
  type SessionSpec,
  type SessionSummary,
} from "@loom/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SessionManager } from "../core/sessionManager.ts";
import { HubError } from "../errors.ts";
import { projectRoot } from "../git/project.ts";
import { cardBranch } from "../git/worktrees.ts";

interface Loaded {
  board: BoardFile;
  stamp: string;
  loadError?: string;
}

export type BoardListener = (board: BoardView) => void;

export interface BoardServiceOptions {
  manager: SessionManager;
  now?: () => number;
  newId?: () => string;
}

/**
 * Project task boards in `<project>/.loom/board.json` (M4). Dispatching a card starts a session;
 * the card then follows its session: running while it works, review when a turn ends, failed on error.
 */
export class BoardService {
  #manager: SessionManager;
  #now: () => number;
  #newId: () => string;
  #cache = new Map<string, Loaded>();
  #caps = new Map<string, number>();
  #draining = new Map<string, Promise<void>>();
  #listeners = new Set<BoardListener>();
  /** Sessions that have been seen working since dispatch, so a start-up idle does not mean "done". */
  #worked = new Set<string>();

  constructor(opts: BoardServiceOptions) {
    this.#manager = opts.manager;
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
    this.#manager.subscribe((e) => this.#onEvent(e));
  }

  onChange(listener: BoardListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  rootFor(cwd: string): string {
    return projectRoot(cwd);
  }

  view(cwd: string): BoardView {
    return this.#view(this.rootFor(cwd));
  }

  add(cwd: string, input: CardInput): BoardView {
    const root = this.rootFor(cwd);
    const card = CardInput.parse(input);
    const now = this.#now();
    return this.#mutate(root, (b) => {
      b.cards.push({ ...card, id: this.#newId(), status: "todo", createdAt: now, updatedAt: now });
    });
  }

  update(cwd: string, cardId: string, input: CardInput): BoardView {
    const root = this.rootFor(cwd);
    const next = CardInput.parse(input);
    return this.#mutate(root, (b) => {
      const card = findCard(b, cardId);
      if (card.status === "running" && (next.kind !== card.kind || JSON.stringify(next.worktree) !== JSON.stringify(card.worktree))) {
        throw new HubError("invalid", "a running card's kind and worktree cannot change");
      }
      Object.assign(card, stripUndefined(next), { updatedAt: this.#now() });
      for (const key of ["model", "level", "worktree"] as const) if (next[key] === undefined) delete card[key];
    });
  }

  move(cwd: string, cardId: string, status: CardStatus): BoardView {
    const root = this.rootFor(cwd);
    const view = this.#mutate(root, (b) => {
      const card = findCard(b, cardId);
      card.status = status;
      card.updatedAt = this.#now();
      if (status === "todo") {
        delete card.sessionId;
        delete card.lastError;
      }
    });
    void this.#drain(root);
    return view;
  }

  remove(cwd: string, cardId: string): BoardView {
    const root = this.rootFor(cwd);
    return this.#mutate(root, (b) => {
      findCard(b, cardId);
      b.cards = b.cards.filter((c) => c.id !== cardId);
    });
  }

  async dispatch(cwd: string, cardId: string): Promise<SessionSummary> {
    return this.#dispatch(this.rootFor(cwd), cardId);
  }

  run(cwd: string, cap: number | null): BoardView {
    const root = this.rootFor(cwd);
    if (cap === null) this.#caps.delete(root);
    else this.#caps.set(root, cap);
    const view = this.#view(root);
    this.#emit(view);
    void this.#drain(root);
    return view;
  }

  // -------------------------------------------------------------------------

  async #dispatch(root: string, cardId: string): Promise<SessionSummary> {
    let card!: Card;
    this.#mutate(root, (b) => {
      card = findCard(b, cardId);
      if (card.status !== "todo" && card.status !== "failed") {
        throw new HubError("invalid", `card "${card.title}" is ${card.status}; only to-do or failed cards can be dispatched`);
      }
      card.status = "running";
      delete card.lastError;
      delete card.sessionId;
      card.updatedAt = this.#now();
    });

    const spec = specFor(card, root);
    try {
      const session = await this.#manager.create(spec);
      this.#mutate(root, (b) => {
        const c = b.cards.find((x) => x.id === cardId);
        if (c) {
          c.sessionId = session.id;
          c.updatedAt = this.#now();
        }
      });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#mutate(root, (b) => {
        const c = b.cards.find((x) => x.id === cardId);
        if (c) {
          c.status = "failed";
          c.lastError = message;
          c.updatedAt = this.#now();
        }
      });
      throw err;
    }
  }

  /** Keeps up to the run cap of cards going. Serialized per board. */
  #drain(root: string): Promise<void> {
    const previous = this.#draining.get(root) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (;;) {
        const cap = this.#caps.get(root);
        if (cap === undefined) return;
        const { board } = this.#load(root);
        const running = board.cards.filter((c) => c.status === "running").length;
        const nextCard = board.cards.find((c) => c.status === "todo");
        if (running >= cap || !nextCard) {
          if (!nextCard && running === 0) {
            this.#caps.delete(root);
            this.#emit(this.#view(root));
          }
          return;
        }
        await this.#dispatch(root, nextCard.id).catch(() => undefined);
      }
    });
    this.#draining.set(root, next.catch(() => undefined));
    return next;
  }

  #onEvent(e: HubEvent): void {
    const ev = e.event;
    if (ev.type !== "session.state" && ev.type !== "session.ended") return;
    const s = this.#manager.projection.sessions.get(e.sessionId);
    if (!s?.cardId) return;
    const root = s.projectRoot;

    let target: CardStatus | undefined;
    let error: string | undefined;
    if (ev.type === "session.state") {
      if (ev.state === "working") {
        this.#worked.add(e.sessionId);
        target = "running";
      } else if (ev.state === "idle" && ev.provenance === "pushed" && this.#worked.has(e.sessionId)) {
        target = "review";
      }
    } else if (ev.outcome === "error") {
      target = "failed";
      error = ev.message;
    } else {
      target = "review";
    }
    if (!target) return;

    let changed = false;
    try {
      this.#mutate(root, (b) => {
        const card = b.cards.find((c) => c.id === s.cardId && c.sessionId === e.sessionId);
        if (!card) return;
        const allowed =
          (target === "running" && card.status === "review") ||
          (target === "review" && card.status === "running") ||
          (target === "failed" && (card.status === "running" || card.status === "review"));
        if (!allowed) return;
        card.status = target!;
        if (error) card.lastError = error;
        card.updatedAt = this.#now();
        changed = true;
      }, { onlyIfChanged: () => changed });
    } catch (err) {
      console.error("board update failed:", err);
      return;
    }
    if (changed && target !== "running") void this.#drain(root);
  }

  #file(root: string): string {
    return path.join(root, ".loom", "board.json");
  }

  #load(root: string): Loaded {
    const file = this.#file(root);
    let stamp = "missing";
    try {
      const st = statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // no board yet
    }
    const cached = this.#cache.get(root);
    if (cached && cached.stamp === stamp) return cached;

    let loaded: Loaded;
    if (stamp === "missing") loaded = { board: { version: 1, cards: [] }, stamp };
    else {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const parsed = BoardFileSchema.safeParse(raw);
        loaded = parsed.success
          ? { board: parsed.data, stamp }
          : { board: { version: 1, cards: [] }, stamp, loadError: z.prettifyError(parsed.error) };
      } catch (err) {
        loaded = { board: { version: 1, cards: [] }, stamp, loadError: `not valid JSON: ${(err as Error).message}` };
      }
    }
    this.#cache.set(root, loaded);
    return loaded;
  }

  #view(root: string): BoardView {
    const loaded = this.#load(root);
    const cap = this.#caps.get(root);
    return {
      root,
      path: this.#file(root),
      cards: loaded.board.cards,
      ...(cap !== undefined ? { runCap: cap } : {}),
      ...(loaded.loadError ? { loadError: loaded.loadError } : {}),
    };
  }

  /** Applies a change to a fresh copy of the board and writes it. Refuses to overwrite a board that failed to load. */
  #mutate(root: string, change: (board: BoardFile) => void, opts: { onlyIfChanged?: () => boolean } = {}): BoardView {
    const loaded = this.#load(root);
    if (loaded.loadError) throw new HubError("invalid", `${this.#file(root)} could not be read, so Loom will not overwrite it: ${loaded.loadError}`);
    const board: BoardFile = structuredClone(loaded.board);
    change(board);
    if (opts.onlyIfChanged && !opts.onlyIfChanged()) return this.#view(root);
    const file = this.#file(root);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`);
    renameSync(tmp, file);
    this.#cache.delete(root);
    const view = this.#view(root);
    this.#emit(view);
    return view;
  }

  #emit(view: BoardView): void {
    for (const l of this.#listeners) {
      try {
        l(view);
      } catch (err) {
        console.error("board listener failed:", err);
      }
    }
  }
}

function findCard(board: BoardFile, id: string): Card {
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new HubError("not-found", `no card ${id}`);
  return card;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The session a card starts. */
export function specFor(card: Card, root: string): SessionSpec {
  const common = {
    cwd: root,
    cardId: card.id,
    ...(card.worktree ? { worktree: { branch: cardBranch(card.title, card.id), ...(card.worktree.baseRef ? { baseRef: card.worktree.baseRef } : {}) } } : {}),
  };
  const prompt = card.prompt.trim();
  switch (card.kind) {
    case "chat":
      return { ...common, adapter: "claude-sdk", ...(prompt ? { prompt } : {}), ...(card.model ? { model: card.model } : {}), ...(card.level ? { level: card.level } : {}) };
    case "claude-terminal":
      return { ...common, adapter: "pty", agent: "claude", ...(prompt ? { prompt } : {}), ...(card.model ? { model: card.model } : {}), ...(card.level ? { level: card.level } : {}) };
    case "terminal":
      return { ...common, adapter: "pty", ...(prompt ? { command: prompt } : {}) };
  }
}

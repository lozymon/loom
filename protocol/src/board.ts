import { z } from "zod";
import { PermissionLevel } from "./levels.ts";

/**
 * A project's task board, stored in `<project>/.loom/board.json` (ADR-0012, v1 carried forward).
 * Lanes: to do, running, review, done, failed. The hub moves cards between running, review, and failed
 * as their sessions progress; people move everything else.
 */
export const CardStatus = z.enum(["todo", "running", "review", "done", "failed"]);
export type CardStatus = z.infer<typeof CardStatus>;

export const CardKind = z.enum(["chat", "claude-terminal", "terminal"]);
export type CardKind = z.infer<typeof CardKind>;

/** What a person or agent may set on a card. */
export const CardInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** First message for the session. For terminal cards, the command to run. */
    prompt: z.string().max(20_000).default(""),
    kind: CardKind.default("chat"),
    model: z.string().min(1).optional(),
    level: PermissionLevel.optional(),
    /** Run in a new worktree on a branch named after the card. `baseRef` defaults to the repository's HEAD. */
    worktree: z.object({ baseRef: z.string().min(1).optional() }).strict().optional(),
  })
  .strict();
export type CardInput = z.infer<typeof CardInput>;

export const Card = CardInput.extend({
  id: z.string().min(1),
  status: CardStatus,
  sessionId: z.string().optional(),
  /** Why the last dispatch or run failed, shown on the card. */
  lastError: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Card = z.infer<typeof Card>;

export const BoardFile = z.object({ version: z.literal(1), cards: z.array(Card) }).strict();
export type BoardFile = z.infer<typeof BoardFile>;

export const BoardView = z.object({
  root: z.string(),
  path: z.string(),
  cards: z.array(Card),
  /** How many cards "Run" keeps going at once, or absent when it is off. In memory only. */
  runCap: z.number().int().positive().optional(),
  loadError: z.string().optional(),
});
export type BoardView = z.infer<typeof BoardView>;

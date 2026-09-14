import { z } from "zod";
import { BoardView } from "./board.ts";
import { Command } from "./commands.ts";
import { HubEvent } from "./events.ts";
import { HubId, Seq } from "./ids.ts";
import { PermissionLevel } from "./levels.ts";
import { VoiceInfo } from "./voice.ts";

/**
 * Everything on the WebSocket is one JSON frame per message (ADR-0008).
 *
 * Client → hub: `hello` once, then `req` frames.
 * Hub → client: `welcome` once, then `res` frames (one per req, matched by id) and `evt` frames.
 */

export const Hello = z.object({
  t: z.literal("hello"),
  protocol: z.number().int().positive(),
  client: z.object({ kind: z.enum(["desktop", "web", "pwa", "cli", "mcp"]), version: z.string() }),
  /** Bearer token. Absent on the local unix socket / named pipe, required on TCP. */
  token: z.string().optional(),
});
export type Hello = z.infer<typeof Hello>;

export const Request = z.object({
  t: z.literal("req"),
  /** Client-chosen, unique per connection. */
  id: z.number().int().nonnegative(),
  body: Command,
});
export type Request = z.infer<typeof Request>;

export const ClientFrame = z.discriminatedUnion("t", [Hello, Request]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const Welcome = z.object({
  t: z.literal("welcome"),
  protocol: z.number().int().positive(),
  hub: z.object({
    id: HubId,
    name: z.string(),
    version: z.string(),
    platform: z.enum(["linux", "win32", "darwin"]),
    maxLevel: PermissionLevel,
    defaultLevel: PermissionLevel,
    /** Whether the Steward's model stage may run on this hub (off on the work hub, decision 3). */
    stewardModel: z.boolean(),
    steward: z.object({ mode: z.enum(["recommend", "decide"]), model: z.string() }).optional(),
    voice: VoiceInfo.optional(),
  }),
  /** Latest seq in the hub's log at connect time. */
  headSeq: Seq,
  /** Who this connection acts as. */
  you: z
    .union([
      z.object({ kind: z.literal("human") }),
      z.object({ kind: z.literal("session"), sessionId: z.string(), name: z.string(), role: z.enum(["session", "cockpit"]) }),
    ])
    .optional(),
});
export type Welcome = z.infer<typeof Welcome>;

export const ErrorCode = z.enum([
  "bad-frame",
  "protocol-mismatch",
  "unauthorized",
  "not-found",
  "forbidden",
  "invalid",
  "engine",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Response = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("res"), id: z.number().int().nonnegative(), ok: z.literal(true), data: z.unknown().optional() }),
  z.object({
    t: z.literal("res"),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.object({ code: ErrorCode, message: z.string() }),
  }),
]);
export type Response = z.infer<typeof Response>;

export const EventFrame = z.object({ t: z.literal("evt"), e: HubEvent });
export type EventFrame = z.infer<typeof EventFrame>;

/**
 * Terminal output for an attached session. `offset` is the byte position of the first byte of
 * `data` (base64) in that terminal's output since it started, so clients drop anything they already
 * have. Never logged (ADR-0003).
 */
export const TermFrame = z.object({
  t: z.literal("term"),
  sessionId: z.string(),
  offset: z.number().int().nonnegative(),
  data: z.string(),
});
export type TermFrame = z.infer<typeof TermFrame>;

/** A board changed. Sent to connections that asked for that board with `board.get`. Not logged; the file is the source of truth. */
export const BoardFrame = z.object({ t: z.literal("board"), board: BoardView });
export type BoardFrame = z.infer<typeof BoardFrame>;

/** Hub → client. Not a discriminated union on `t` alone because Response splits on `ok`. */
export const HubFrame = z.union([Welcome, Response, EventFrame, TermFrame, BoardFrame]);
export type HubFrame = z.infer<typeof HubFrame>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "frame is not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

/** Validates one inbound frame on the hub. Never throws. */
export function parseClientFrame(raw: string): ParseResult<ClientFrame> {
  return parseWith(ClientFrame, raw);
}

/** Validates one inbound frame on a client. Never throws. */
export function parseHubFrame(raw: string): ParseResult<HubFrame> {
  return parseWith(HubFrame, raw);
}

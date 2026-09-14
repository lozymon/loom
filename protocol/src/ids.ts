import { z } from "zod";

// Identities are plain strings on the wire. The aliases exist so signatures say what they
// mean; they are not branded, because every id crosses JSON and a brand would be a lie there.

/** A hub, as a client knows it. Stable per hub install; the display name is separate. */
export const HubId = z.string().min(1);
export type HubId = z.infer<typeof HubId>;

/** A Loom session. Distinct from the engine's own id (e.g. Claude's session UUID), see SessionSummary.engineSessionId. */
export const SessionId = z.string().min(1);
export type SessionId = z.infer<typeof SessionId>;

/** One pending or resolved approval (permission prompt or clarifying question). */
export const ApprovalId = z.string().min(1);
export type ApprovalId = z.infer<typeof ApprovalId>;

/** A task board card, project-scoped in `<repo>/.loom/board.json`. */
export const CardId = z.string().min(1);
export type CardId = z.infer<typeof CardId>;

/**
 * Position in a hub's append-only event log. Strictly increasing per hub, never reused.
 * A reconnecting client asks for events after the last seq it applied (ADR-0003).
 */
export const Seq = z.number().int().nonnegative();
export type Seq = z.infer<typeof Seq>;

/** Milliseconds since the Unix epoch, as stamped by the hub. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

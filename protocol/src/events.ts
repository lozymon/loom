import { z } from "zod";
import { ApprovalDecision, ApprovalRequest, Resolver, StewardReview } from "./approvals.ts";
import { ApprovalId, HubId, Seq, SessionId, Timestamp } from "./ids.ts";
import { UserMessageSource } from "./session.ts";
import { PermissionLevel } from "./levels.ts";
import { RuleRef } from "./policy.ts";
import { BlockedOn, EngineLoaded, Provenance, SessionSpec, SessionState, SessionSummary } from "./session.ts";
import { SpokenLanguage } from "./voice.ts";

/**
 * Normalized session events (ADR-0004). Every adapter emits these and nothing engine-specific
 * reaches a client.
 *
 * Every event that affects a SessionSummary sets a value rather than adjusting one, so applying
 * the same events twice in order converges to the same state (see projection.ts).
 */
export const SessionEvent = z.discriminatedUnion("type", [
  /** `spec` is kept so the hub can restart the engine with the same role, model, and cwd. */
  z.object({ type: z.literal("session.created"), summary: SessionSummary, spec: SessionSpec }),
  z.object({
    type: z.literal("session.state"),
    state: SessionState,
    blockedOn: BlockedOn.optional(),
    provenance: Provenance,
  }),
  z.object({ type: z.literal("session.level"), level: PermissionLevel, by: z.enum(["human", "cockpit", "hub"]) }),
  /** Engine identity and what it loaded. Emitted when the engine starts or reports a change. */
  z.object({
    type: z.literal("session.engine"),
    engineSessionId: z.string(),
    model: z.string().optional(),
    loaded: EngineLoaded.optional(),
  }),
  /** What a terminal session is running, published when it launches. */
  z.object({ type: z.literal("session.process"), command: z.string(), agent: z.string().optional() }),
  /** Engine process started (true) or is no longer running (false). */
  z.object({ type: z.literal("session.live"), live: z.boolean() }),
  z.object({ type: z.literal("session.renamed"), name: z.string(), subtitle: z.string().optional() }),
  z.object({ type: z.literal("session.archived"), archived: z.boolean(), worktreeRemoved: z.boolean().optional() }),
  z.object({ type: z.literal("session.ended"), outcome: z.enum(["done", "error", "stopped"]), message: z.string().optional() }),

  z.object({ type: z.literal("user.message"), text: z.string(), from: UserMessageSource }),
  z.object({ type: z.literal("assistant.text"), messageId: z.string(), text: z.string(), parentToolUseId: z.string().optional() }),
  z.object({ type: z.literal("assistant.thinking"), messageId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("tool.use"),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    parentToolUseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.result"),
    toolUseId: z.string(),
    isError: z.boolean(),
    /** Truncated text form for display. Full output stays in the engine transcript. */
    preview: z.string(),
  }),

  z.object({ type: z.literal("approval.requested"), request: ApprovalRequest }),
  z.object({
    type: z.literal("approval.resolved"),
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    resolver: Resolver,
    /** Rule text, Steward reason, or human note, for the audit trail. */
    detail: z.string().optional(),
    /** The rule that decided it, when resolver is `rule`, or the rule saved by an `allow-rule` decision. */
    rule: RuleRef.optional(),
  }),

  /** A pending approval's Steward review changed. */
  z.object({ type: z.literal("approval.updated"), approvalId: ApprovalId, steward: StewardReview }),
  /** A person rejected an action the Steward had allowed. The action may already have run. */
  z.object({ type: z.literal("approval.overridden"), approvalId: ApprovalId, note: z.string() }),
  z.object({
    type: z.literal("files.changed"),
    files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
  }),
  /** Session total, not a delta. */
  z.object({ type: z.literal("cost.update"), costUsd: z.number().nonnegative() }),

  /** pty adapter: the process exited. Terminal bytes themselves travel in `term` frames, never as events. */
  z.object({ type: z.literal("terminal.exit"), code: z.number().int() }),

  z.object({ type: z.literal("error"), message: z.string() }),

  /** The session said something out loud (the `speak` tool). Shown as text too; clients may read it. */
  z.object({ type: z.literal("speech"), text: z.string().min(1).max(2000), lang: SpokenLanguage.optional() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];

/**
 * Event types that are streamed live but never written to the event log. Empty since terminal
 * output moved to `term` frames; kept so a future ephemeral event has one place to go.
 */
export const EPHEMERAL_EVENT_TYPES = [] as const satisfies readonly SessionEventType[];

/** A session event as it sits in the hub's log and travels to clients. */
export const HubEvent = z.object({
  seq: Seq,
  at: Timestamp,
  hubId: HubId,
  sessionId: SessionId,
  event: SessionEvent,
});
export type HubEvent = z.infer<typeof HubEvent>;

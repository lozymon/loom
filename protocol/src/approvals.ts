import { z } from "zod";
import { ApprovalId, SessionId, Timestamp } from "./ids.ts";
import { PolicyScope, RuleRef } from "./policy.ts";

/** One option of a clarifying question. Mirrors Claude Code's AskUserQuestion shape. */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  /** Optional markdown or HTML mockup, when the engine provides one. */
  preview: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(QuestionOption),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof Question>;

/**
 * The Steward's review of an approval (ADR-0006 stage 2). `reviewing` while the model thinks; `done`
 * with its verdict; `unavailable` when the review could not run (failure, budget, timeout).
 */
export const StewardReview = z.object({
  status: z.enum(["reviewing", "done", "unavailable"]),
  /** `recommend` only advises a person; `decide` may resolve the approval itself. */
  mode: z.enum(["recommend", "decide"]),
  decision: z.enum(["allow", "deny", "escalate"]).optional(),
  /** Probability that a careful developer would decide the same, as the model judged it. */
  confidence: z.number().min(0).max(1).optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  reason: z.string().optional(),
  /** Why the hub did not act on the verdict: below threshold, over budget, or advice only. */
  heldBecause: z.string().optional(),
  model: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type StewardReview = z.infer<typeof StewardReview>;

const approvalBase = {
  id: ApprovalId,
  sessionId: SessionId,
  requestedAt: Timestamp,
  /**
   * A one-line human description built by the hub, e.g. `Write src/app.ts` or `Run: npm test`.
   * Built from tool name and input, because the engine's own title is not reliably present
   * (observed empty in the 2026-09-12 smoke test).
   */
  summary: z.string(),
  steward: StewardReview.optional(),
  /** When the approval is denied automatically if nobody decides (approval timeout). */
  expiresAt: Timestamp.optional(),
};

/**
 * Something a session needs decided before it continues. Two kinds, one queue.
 * An Approval is raised by an agent about its own work (v1 CONTEXT.md vocabulary).
 */
export const ApprovalRequest = z.discriminatedUnion("kind", [
  z.object({
    ...approvalBase,
    kind: z.literal("permission"),
    toolName: z.string(),
    /** The tool input exactly as the engine sent it. Rendered as a diff for edits, a command for shells. */
    input: z.record(z.string(), z.unknown()),
    /** Why the engine asked, when it says. */
    reason: z.string().optional(),
    /** Path that triggered the prompt, when outside the workspace. */
    blockedPath: z.string().optional(),
    /** True when the engine offers a persistent "always allow" rule for this call. */
    canAlwaysAllow: z.boolean(),
    /** An ask rule matched: a person must decide, every time, and no always-allow is offered. */
    mustAsk: z.boolean().optional(),
    askRule: RuleRef.optional(),
    /** A rule Loom proposes for "always allow in Loom policy". The person may edit it before saving. */
    suggestedRule: z.string().optional(),
  }),
  z.object({
    ...approvalBase,
    kind: z.literal("question"),
    questions: z.array(Question).min(1),
  }),
]);
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** A decision on an approval, from any resolver. */
export const ApprovalDecision = z.discriminatedUnion("type", [
  z.object({ type: z.literal("allow") }),
  /** Allow and persist the engine's suggested rule so matching calls stop asking. */
  z.object({ type: z.literal("allow-always") }),
  /** Allow, and save `rule` to a Loom policy so matching calls are allowed without asking. */
  z.object({ type: z.literal("allow-rule"), rule: z.string().trim().min(1), scope: PolicyScope }),
  /** Allow with a modified tool input. */
  z.object({ type: z.literal("allow-edited"), input: z.record(z.string(), z.unknown()) }),
  /** Deny. The message is shown to the agent, so it can adjust. */
  z.object({ type: z.literal("deny"), message: z.string(), interrupt: z.boolean().optional() }),
  /** Answer a clarifying question, keyed by question text. */
  z.object({
    type: z.literal("answer"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  /** Dismiss the question card and reply in free text instead. */
  z.object({ type: z.literal("reply"), text: z.string() }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * Which stage of the pipeline resolved an approval. Every resolution is audited with this.
 * `hub` means the hub cancelled it, for example because the session stopped or the hub restarted.
 */
export const Resolver = z.enum(["rule", "steward", "human", "cockpit", "timeout", "hub"]);
export type Resolver = z.infer<typeof Resolver>;

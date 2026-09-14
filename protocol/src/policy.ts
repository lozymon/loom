import { z } from "zod";

/**
 * Permission rules in Claude Code's syntax: `Tool` or `Tool(specifier)` (ADR-0006).
 * Hub policy lives next to hub.json; project policy in `<root>/.loom/policy.json` (ADR-0012).
 */
export const RuleList = z.array(z.string().trim().min(1)).max(500);

export const ApprovalTimeout = z
  .object({
    minutes: z.number().int().min(1).max(24 * 60),
    /** What happens when the time runs out: deny, or let the Steward decide (denying if it escalates). */
    then: z.enum(["deny", "steward"]),
  })
  .strict();
export type ApprovalTimeout = z.infer<typeof ApprovalTimeout>;

export const PolicyFile = z
  .object({
    allow: RuleList.default([]),
    deny: RuleList.default([]),
    ask: RuleList.default([]),
    approvalTimeout: ApprovalTimeout.optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFile>;

export const RuleListName = z.enum(["allow", "deny", "ask"]);
export type RuleListName = z.infer<typeof RuleListName>;

export const RuleProblem = z.object({ list: RuleListName, rule: z.string(), message: z.string() });
export type RuleProblem = z.infer<typeof RuleProblem>;

export const PolicyScope = z.enum(["hub", "project"]);
export type PolicyScope = z.infer<typeof PolicyScope>;

/** A policy as the client sees it: what the file says, whether it loaded, and what the hub made of it. */
export const PolicySourceView = z.object({
  path: z.string(),
  exists: z.boolean(),
  policy: PolicyFile,
  /** Set when the file could not be read or parsed; the policy shown is then empty. */
  loadError: z.string().optional(),
  problems: z.array(RuleProblem),
});
export type PolicySourceView = z.infer<typeof PolicySourceView>;

export const PolicyView = z.object({
  hub: PolicySourceView,
  project: PolicySourceView.extend({
    root: z.string(),
    /** False when the allow list has not been trusted on this hub; its allow rules are then ignored. */
    trusted: z.boolean(),
    /** Hash of the allow list, passed back to `policy.trust` so a person trusts exactly what they saw. */
    allowHash: z.string(),
  }),
});
export type PolicyView = z.infer<typeof PolicyView>;

/** Where a rule came from. `builtin` rules protect Loom's own policy and trust files. */
export const RuleScope = z.enum(["hub", "project", "builtin"]);
export type RuleScope = z.infer<typeof RuleScope>;

/** Which rule decided an approval, for the audit trail and "why was this allowed". */
export const RuleRef = z.object({
  list: RuleListName,
  rule: z.string(),
  scope: RuleScope,
  path: z.string(),
});
export type RuleRef = z.infer<typeof RuleRef>;

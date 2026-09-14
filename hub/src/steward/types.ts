import type { ApprovalRequest, SessionSummary } from "@loom/protocol";

export type Verdict = {
  decision: "allow" | "deny" | "escalate";
  confidence: number;
  risk: "low" | "medium" | "high";
  reason: string;
};

export type ReviewResult = Verdict & { model: string; costUsd: number; durationMs: number };

/** Everything the Steward may see about one request. */
export interface ReviewInput {
  request: Extract<ApprovalRequest, { kind: "permission" }>;
  session: Pick<SessionSummary, "name" | "cwd" | "projectRoot" | "branch" | "level" | "adapter" | "agent" | "model">;
  card?: { title: string; prompt: string } | undefined;
  /** Oldest first, already shortened. */
  activity: string[];
  rules: { deny: string[]; ask: string[] };
  diffStat?: string | undefined;
}

/** The model behind the Steward. Replaced by a fake in tests. */
export interface StewardModel {
  review(input: ReviewInput, opts: { model: string; instructions?: string | undefined; signal: AbortSignal }): Promise<ReviewResult>;
}

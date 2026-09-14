import type { StewardReview } from "@loom/protocol";
import type { HubConfig } from "../config.ts";
import type { ReviewInput, ReviewResult, StewardModel } from "./types.ts";

const HOUR = 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 90_000;

export type StewardSettings = HubConfig["steward"] & { enabled: boolean };

export type Outcome =
  /** Act on it: resolve the approval. */
  | { act: "allow" | "deny"; review: StewardReview }
  /** Keep it for a person, with the review attached. */
  | { act: "hold"; review: StewardReview };

/**
 * The Steward service (ADR-0006 stage 2). The model gives a verdict; this class decides whether the
 * hub may act on it. Thresholds and budgets live here, outside anything a transcript can influence.
 */
export class Steward {
  readonly settings: StewardSettings;
  #model: StewardModel;
  #now: () => number;
  #decisions = new Map<string, number[]>();
  #spendDay = "";
  #spendToday = 0;

  constructor(settings: StewardSettings, model: StewardModel, now: () => number = Date.now) {
    this.settings = settings;
    this.#model = model;
    this.#now = now;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get spendToday(): number {
    this.#rollDay();
    return this.#spendToday;
  }

  reviewing(): StewardReview {
    return { status: "reviewing", mode: this.settings.mode };
  }

  /**
   * Reviews and returns what the hub may do. `forceDecide` is for approval timeouts set to hand over
   * to the Steward: it acts even in recommend mode, and anything it will not allow or deny is denied by the caller.
   */
  async review(input: ReviewInput, opts: { sessionId: string; terminal: boolean; forceDecide?: boolean; signal?: AbortSignal }): Promise<Outcome> {
    const mode = opts.forceDecide ? "decide" : this.settings.mode;
    this.#rollDay();
    if (this.#spendToday >= this.settings.maxDailyUsd) {
      return { act: "hold", review: { status: "unavailable", mode, heldBecause: `the Steward's daily budget of $${this.settings.maxDailyUsd} is used up` } };
    }
    if (mode === "decide" && this.#recentDecisions(opts.sessionId) >= this.settings.maxDecisionsPerHour) {
      return {
        act: "hold",
        review: { status: "unavailable", mode, heldBecause: `${this.settings.maxDecisionsPerHour} automatic decisions in the last hour for this session` },
      };
    }

    const timeout = AbortSignal.timeout(REVIEW_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let result: ReviewResult;
    try {
      result = await this.#model.review(input, { model: this.settings.model, instructions: this.settings.instructions, signal });
    } catch (err) {
      const why = timeout.aborted ? "the review timed out" : `the review failed: ${err instanceof Error ? err.message : String(err)}`;
      return { act: "hold", review: { status: "unavailable", mode, heldBecause: why } };
    }
    this.#spendToday += result.costUsd;

    const review: StewardReview = {
      status: "done",
      mode,
      decision: result.decision,
      confidence: result.confidence,
      risk: result.risk,
      reason: result.reason,
      model: result.model,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
    const threshold = Math.min(1, this.settings.minConfidence + (opts.terminal ? 0.05 : 0));

    if (result.decision === "escalate") return { act: "hold", review };
    if (mode === "recommend") return { act: "hold", review: { ...review, heldBecause: "recommend mode: the Steward only advises" } };
    if (result.confidence < threshold) {
      return { act: "hold", review: { ...review, heldBecause: `confidence ${Math.round(result.confidence * 100)}% is below ${Math.round(threshold * 100)}%` } };
    }
    if (result.decision === "allow" && result.risk === "high") {
      return { act: "hold", review: { ...review, heldBecause: "the Steward rated the risk high" } };
    }
    this.#recordDecision(opts.sessionId);
    return { act: result.decision, review };
  }

  #recentDecisions(sessionId: string): number {
    const cutoff = this.#now() - HOUR;
    const kept = (this.#decisions.get(sessionId) ?? []).filter((t) => t > cutoff);
    this.#decisions.set(sessionId, kept);
    return kept.length;
  }

  #recordDecision(sessionId: string): void {
    this.#recentDecisions(sessionId);
    this.#decisions.get(sessionId)!.push(this.#now());
  }

  #rollDay(): void {
    const d = new Date(this.#now());
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (day !== this.#spendDay) {
      this.#spendDay = day;
      this.#spendToday = 0;
    }
  }
}

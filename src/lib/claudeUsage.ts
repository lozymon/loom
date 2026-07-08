// Token/cost accounting for the Fleet panel's usage HUD. Reads per-session token totals (by model)
// from the Rust `claude_usage` command — which sums Claude's own on-disk transcripts, never pane
// output (ADR-0001) — and prices them with a small per-model table.
//
// Pricing is an *estimate*: rates are $/million-tokens sourced from the claude-api reference
// (cached 2026-06), and can drift. Output is 5× input across the current lineup; cache read is
// 0.1× input; cache writes are 1.25× (5-minute TTL) and 2× (1-hour TTL) of input.

import { invoke } from "@tauri-apps/api/core";

/** Token totals for one model within a session (mirrors Rust `ModelUsage`). */
export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** One session's usage, broken down by model (mirrors Rust `SessionUsage`). */
export interface SessionUsage {
  id: string;
  models: ModelUsage[];
}

/** Sum usage for the given Claude session ids. Best-effort: a failure yields an empty list. */
export async function claudeUsage(sessionIds: string[]): Promise<SessionUsage[]> {
  if (sessionIds.length === 0) return [];
  try {
    return await invoke<SessionUsage[]>("claude_usage", { sessionIds });
  } catch (e) {
    console.error("claude_usage failed", e);
    return [];
  }
}

/** Input price ($/million tokens) per model. Output/cache rates derive from this. */
const INPUT_PRICE: Record<string, number> = {
  "claude-opus-4-8": 5,
  "claude-opus-4-7": 5,
  "claude-opus-4-6": 5,
  "claude-opus-4-5": 5,
  "claude-sonnet-5": 3,
  "claude-sonnet-4-6": 3,
  "claude-sonnet-4-5": 3,
  "claude-haiku-4-5": 1,
};

/** The input $/MTok rate for a model id, or null if unknown (exact match, then prefix so a dated
 *  snapshot like `claude-haiku-4-5-20251001` resolves to its base). */
export function inputRate(model: string): number | null {
  if (model in INPUT_PRICE) return INPUT_PRICE[model];
  const base = Object.keys(INPUT_PRICE).find((k) => model.startsWith(k));
  return base ? INPUT_PRICE[base] : null;
}

/** Estimated USD cost for one model's usage, or null when the model isn't priced. */
export function modelCost(u: ModelUsage): number | null {
  const inRate = inputRate(u.model);
  if (inRate === null) return null;
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    per(u.input, inRate) +
    per(u.output, inRate * 5) +
    per(u.cacheRead, inRate * 0.1) +
    per(u.cacheWrite5m, inRate * 1.25) +
    per(u.cacheWrite1h, inRate * 2)
  );
}

/** Total estimated USD for a session (sum across its models; unpriced models contribute 0). */
export function sessionCost(s: SessionUsage): number {
  return s.models.reduce((sum, m) => sum + (modelCost(m) ?? 0), 0);
}

/** Total tokens for a session (all classes, all models) — the headline "size" figure. */
export function sessionTokens(s: SessionUsage): number {
  return s.models.reduce(
    (sum, m) => sum + m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h,
    0,
  );
}

/** Compact token count, e.g. "1.2M" / "45.3k" / "812". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** Compact USD, e.g. "$0.42" / "$12.90" / "$1.2k". */
export function fmtUsd(n: number): string {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

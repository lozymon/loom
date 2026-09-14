import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renderReview, STEWARD_SYSTEM, VERDICT_SCHEMA } from "./prompt.ts";
import type { ReviewInput, ReviewResult, StewardModel } from "./types.ts";

const Verdict = z.object({
  decision: z.enum(["allow", "deny", "escalate"]),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  reason: z.string().min(1),
});

/**
 * Reviews through the Claude Agent SDK on this machine's Claude login: no tools, no user or project
 * settings, no saved transcript, JSON output (M5).
 */
export class ClaudeStewardModel implements StewardModel {
  #workDir: string;
  #queryFn: typeof query;

  #executable: string | undefined;

  constructor(opts: { workDir: string; queryFn?: typeof query; claudeExecutable?: string | undefined }) {
    this.#workDir = opts.workDir;
    this.#executable = opts.claudeExecutable;
    this.#queryFn = opts.queryFn ?? query;
    mkdirSync(this.#workDir, { recursive: true });
  }

  async review(input: ReviewInput, opts: { model: string; instructions?: string | undefined; signal: AbortSignal }): Promise<ReviewResult> {
    const started = Date.now();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const q = this.#queryFn({
        prompt: renderReview(input, opts.instructions),
        options: {
          cwd: path.resolve(this.#workDir),
          ...(this.#executable ? { pathToClaudeCodeExecutable: this.#executable } : {}),
          model: opts.model,
          systemPrompt: STEWARD_SYSTEM,
          tools: [],
          settingSources: [],
          persistSession: false,
          maxTurns: 3,
          maxBudgetUsd: 0.25,
          abortController: abort,
          outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> },
        },
      });
      let result: { subtype: string; structured_output?: unknown; total_cost_usd: number; errors?: string[] } | undefined;
      for await (const m of q) if (m.type === "result") result = m as typeof result;
      if (!result) throw new Error("the Steward returned no result");
      if (result.subtype !== "success") throw new Error(`the Steward failed: ${result.errors?.join("; ") || result.subtype}`);
      const verdict = Verdict.parse(result.structured_output);
      return { ...verdict, model: opts.model, costUsd: result.total_cost_usd, durationMs: Date.now() - started };
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

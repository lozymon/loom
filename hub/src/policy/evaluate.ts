import type { PolicyFile, RuleListName, RuleProblem, RuleRef, RuleScope } from "@loom/protocol";
import path from "node:path";
import { type MatchContext, ruleMatches, type ToolCall } from "./match.ts";
import { parseRule } from "./rules.ts";

export interface PolicySource {
  scope: RuleScope;
  path: string;
  /** Where `/path` patterns in this file anchor. */
  anchor: string;
  policy: PolicyFile;
  /** Allow rules count only when true (project allow lists need trust, ADR-0012). */
  allowTrusted: boolean;
}

export type Verdict = { kind: "deny" | "ask" | "allow"; rule: RuleRef } | { kind: "none" };

const ORDER: RuleListName[] = ["deny", "ask", "allow"];

/** Deny beats ask beats allow, across every source (ADR-0006). */
export function evaluate(call: ToolCall, sources: PolicySource[], ctx: Omit<MatchContext, "sourceAnchor">): Verdict {
  for (const list of ORDER) {
    for (const source of sources) {
      if (list === "allow" && !source.allowTrusted) continue;
      for (const text of source.policy[list]) {
        const parsed = parseRule(text, list);
        if (!parsed.ok) continue;
        if (ruleMatches(parsed.rule, list, call, { ...ctx, sourceAnchor: source.anchor })) {
          return { kind: list, rule: { list, rule: text, scope: source.scope, path: source.path } };
        }
      }
    }
  }
  return { kind: "none" };
}

export function policyProblems(policy: PolicyFile): RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const list of ORDER) {
    for (const rule of policy[list]) {
      const parsed = parseRule(rule, list);
      if (!parsed.ok) problems.push({ list, rule, message: parsed.message });
    }
  }
  return problems;
}

function escapeGlob(p: string): string {
  return p.replace(/[[\]*?\\]/g, "\\$&");
}

/**
 * A rule to offer for "always allow in Loom policy": narrow by default, so saving it does not quietly
 * approve more than this call. Returns undefined when no safe narrow rule exists.
 */
export function suggestRule(call: ToolCall, cwd: string): string | undefined {
  const { toolName, input } = call;
  if ((toolName === "Bash" || toolName === "PowerShell") && typeof input.command === "string") {
    const cmd = input.command.trim();
    if (!cmd || cmd.includes("\n") || cmd.length > 300) return undefined;
    return `${toolName}(${cmd})`;
  }
  if ((toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") && typeof input.file_path === "string") {
    const rel = path.relative(cwd, input.file_path);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    const shown = inside ? `./${rel.split(path.sep).join("/")}` : `//${input.file_path.replace(/^\/+/, "")}`;
    return `Edit(${escapeGlob(shown)})`;
  }
  if (toolName === "WebFetch" && typeof input.url === "string") {
    try {
      return `WebFetch(domain:${new URL(input.url).hostname})`;
    } catch {
      return undefined;
    }
  }
  if (toolName.startsWith("mcp__")) return toolName;
  return undefined;
}

import type { RuleListName } from "@loom/protocol";
import { realpathSync } from "node:fs";
import { analyzeCommand, commandPatternMatches, denyVariants, escapeRegex } from "./command.ts";
import { domainMatches } from "./domain.ts";
import { type PathContext, pathPatternMatches } from "./paths.ts";
import type { ParsedRule } from "./rules.ts";

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface MatchContext extends PathContext {
  realpath?: (p: string) => string | undefined;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

function targetPath(call: ToolCall, cwd: string): string | undefined {
  const i = call.input;
  const p = i.file_path ?? i.notebook_path ?? i.path;
  if (typeof p === "string" && p !== "") return p;
  return call.toolName === "Grep" || call.toolName === "Glob" ? cwd : undefined;
}

function defaultRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function toolNameMatches(rule: Extract<ParsedRule, { kind: "tool" }>, toolName: string, list: RuleListName): boolean {
  if (rule.glob) return new RegExp(`^${rule.name.split("*").map(escapeRegex).join(".*")}$`).test(toolName);
  if (rule.name === toolName) return true;
  // `mcp__server` covers every tool on that server.
  if (rule.name.startsWith("mcp__") && !rule.name.slice(5).includes("__")) return toolName.startsWith(`${rule.name}__`);
  // `Edit` governs every built-in tool that edits files.
  if (rule.name === "Edit" && EDIT_TOOLS.has(toolName)) return true;
  // `Read` reaches Grep and Glob too, but only to restrict, never to allow more.
  if (rule.name === "Read" && list !== "allow" && READ_TOOLS.has(toolName)) return true;
  return false;
}

export function ruleMatches(rule: ParsedRule, list: RuleListName, call: ToolCall, ctx: MatchContext): boolean {
  const forAllow = list === "allow";
  switch (rule.kind) {
    case "tool":
      return toolNameMatches(rule, call.toolName, list);

    case "command": {
      const ci = rule.tool === "PowerShell";
      if (ci ? call.toolName.toLowerCase() !== "powershell" : call.toolName !== rule.tool) return false;
      const command = call.input.command;
      if (typeof command !== "string") return false;
      const a = analyzeCommand(command);
      if (forAllow) {
        return !a.allowUnsafe && a.subcommands.length > 0 && a.subcommands.every((s) => commandPatternMatches(rule.pattern, s, ci));
      }
      const candidates = [command, ...a.subcommands, ...a.nested].flatMap(denyVariants);
      return candidates.some((c) => commandPatternMatches(rule.pattern, c, ci));
    }

    case "path": {
      const covered =
        rule.tool === "Edit"
          ? EDIT_TOOLS.has(call.toolName)
          : forAllow
            ? call.toolName === "Read"
            : READ_TOOLS.has(call.toolName) || (EDIT_TOOLS.has(call.toolName) && call.toolName !== "NotebookEdit");
      if (!covered) return false;
      const target = targetPath(call, ctx.cwd);
      if (!target) return false;
      if (pathPatternMatches(rule.pattern, target, ctx, forAllow)) return true;
      if (forAllow) return false;
      // Deny and ask also apply to where a symlink points.
      const real = (ctx.realpath ?? defaultRealpath)(target);
      return real !== undefined && real !== target && pathPatternMatches(rule.pattern, real, ctx, false);
    }

    case "domain":
      return call.toolName === "WebFetch" && domainMatches(rule.pattern, call.input.url);

    case "param": {
      if (call.toolName !== rule.tool || forAllow) return false;
      const v = call.input[rule.param];
      if (v === undefined || v === null || typeof v === "object") return false;
      return new RegExp(`^${rule.value.split("*").map(escapeRegex).join(".*")}$`, "s").test(String(v));
    }
  }
}

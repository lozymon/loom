import path from "node:path";
import { toPosix } from "../../policy/paths.ts";

const MAX = 120;

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX ? `${line.slice(0, MAX - 1)}…` : line;
}

function shownPath(p: unknown, cwd: string): string {
  if (typeof p !== "string" || p === "") return "a file";
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * One line describing what a Claude tool call wants to do, for approval cards and read-back.
 * Built from the tool name and input because the SDK's own `title` is not reliably filled in
 * (observed empty, 2026-09-12).
 */
export function approvalSummary(toolName: string, input: Record<string, unknown>, cwd: string, title?: string): string {
  return clip(str(title) ?? describe(toolName, input, cwd));
}

function describe(toolName: string, input: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return str(input.command) ? `Run: ${input.command as string}` : `Run a ${toolName} command`;
    case "Write":
      return `Write ${shownPath(input.file_path, cwd)}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${shownPath(input.file_path, cwd)}`;
    case "NotebookEdit":
      return `Edit notebook ${shownPath(input.notebook_path, cwd)}`;
    case "Read":
      return `Read ${shownPath(input.file_path, cwd)}`;
    case "WebFetch":
      return str(input.url) ? `Fetch ${input.url as string}` : "Fetch a web page";
    case "WebSearch":
      return str(input.query) ? `Search the web: ${input.query as string}` : "Search the web";
    case "AskUserQuestion": {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined) : undefined;
      return str(first?.question) ?? "Claude has a question";
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return `Use ${mcp[2]} from ${mcp[1]}`;
      return `Use ${toolName}`;
    }
  }
}

/**
 * Claude Code's own "don't ask again" suggestion as a rule string, when it offers an allow rule.
 * Preferred over Loom's generic suggestion because Claude knows which part of a compound command asked.
 */
export function ruleFromClaudeSuggestions(suggestions: unknown): string | undefined {
  if (!Array.isArray(suggestions)) return undefined;
  for (const s of suggestions as Array<{ type?: unknown; behavior?: unknown; rules?: unknown }>) {
    if (s?.type !== "addRules" || s.behavior !== "allow" || !Array.isArray(s.rules)) continue;
    const first = s.rules[0] as { toolName?: unknown; ruleContent?: unknown } | undefined;
    if (typeof first?.toolName !== "string") continue;
    return typeof first.ruleContent === "string" && first.ruleContent !== "" ? `${first.toolName}(${first.ruleContent})` : first.toolName;
  }
  return undefined;
}

/** Claude Code ask rules that keep an agent from editing `files` without a person (absolute `//` form). */
export function claudeProtectionRules(files: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return files.map((f) => `Edit(//${toPosix(f, platform).replace(/^\/+/, "")})`);
}

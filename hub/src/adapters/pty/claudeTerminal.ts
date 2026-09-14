import { type ApprovalDecision, type PermissionLevel, Question } from "@loom/protocol";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AdapterHost } from "../../core/adapter.ts";
import { approvalSummary, claudeProtectionRules, ruleFromClaudeSuggestions } from "../claude-sdk/summary.ts";
import { type Launch, type LaunchEnv, programLaunch } from "./launch.ts";

/**
 * Claude Code's own TUI in a terminal, wired to Loom through HTTP hooks passed with
 * `claude --settings` (M2). Nothing is written to the user's Claude settings.
 *
 * Hooks tell Loom when Claude is working or idle, which Claude session id is in use, and route
 * permission prompts and clarifying questions to Loom approvals. If the hub cannot be reached,
 * Claude falls back to its own prompts.
 */

/** Long enough for a person to answer; Claude shows its own prompt if this runs out. */
const DECISION_TIMEOUT_S = 3600;
const EVENT_TIMEOUT_S = 10;

export const CLAUDE_AGENT = "claude";

export function hookSettings(url: string, protectedFiles: readonly string[] = [], withLoomTools = false): object {
  const hook = (timeout: number) => ({
    type: "http",
    url,
    timeout,
    headers: { Authorization: "Bearer $LOOM_HOOK_TOKEN" },
    allowedEnvVars: ["LOOM_HOOK_TOKEN"],
  });
  return {
    ...(protectedFiles.length || withLoomTools
      ? {
          permissions: {
            ...(protectedFiles.length ? { ask: claudeProtectionRules(protectedFiles) } : {}),
            ...(withLoomTools ? { allow: ["mcp__loom__*"] } : {}),
          },
        }
      : {}),
    hooks: {
      SessionStart: [{ hooks: [hook(EVENT_TIMEOUT_S)] }],
      UserPromptSubmit: [{ hooks: [hook(EVENT_TIMEOUT_S)] }],
      Stop: [{ hooks: [hook(EVENT_TIMEOUT_S)] }],
      Notification: [{ matcher: "idle_prompt", hooks: [hook(EVENT_TIMEOUT_S)] }],
      PermissionRequest: [{ hooks: [hook(DECISION_TIMEOUT_S)] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook(DECISION_TIMEOUT_S)] }],
    },
  };
}

function permissionModeArgs(level: PermissionLevel, hubMax: PermissionLevel): string[] {
  const args: string[] = [];
  if (hubMax === "full") args.push("--allow-dangerously-skip-permissions");
  switch (level) {
    case "accept-edits":
      return [...args, "--permission-mode", "acceptEdits"];
    case "full":
      return [...args, "--permission-mode", "bypassPermissions"];
    default:
      return [...args, "--permission-mode", "default"];
  }
}

export interface ClaudeLaunchInput {
  settingsFile: string;
  hookUrl: string;
  resumeEngineSessionId?: string | undefined;
  model?: string | undefined;
  level: PermissionLevel;
  hubMax: PermissionLevel;
  program?: string | undefined;
  protectedFiles?: readonly string[];
  /** First prompt for a fresh session. Ignored when resuming. */
  prompt?: string | undefined;
  /** The loom stdio MCP server; it reads LOOM_* from the terminal's environment, so no token is written to disk. */
  mcpServer?: { command: string; args: string[] } | undefined;
}

export function claudeLaunch(input: ClaudeLaunchInput, le: LaunchEnv): Launch {
  mkdirSync(path.dirname(input.settingsFile), { recursive: true });
  writeFileSync(input.settingsFile, `${JSON.stringify(hookSettings(input.hookUrl, input.protectedFiles, input.mcpServer !== undefined), null, 2)}\n`, { mode: 0o600 });
  const mcpFile = path.join(path.dirname(input.settingsFile), "claude-mcp.json");
  if (input.mcpServer) {
    writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: { loom: { type: "stdio", ...input.mcpServer, alwaysLoad: true } } }, null, 2)}\n`, { mode: 0o600 });
  }
  const args = [
    "--settings",
    input.settingsFile,
    ...(input.mcpServer ? ["--mcp-config", mcpFile] : []),
    ...(input.resumeEngineSessionId ? ["--resume", input.resumeEngineSessionId] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...permissionModeArgs(input.level, input.hubMax),
    ...(input.prompt && !input.resumeEngineSessionId ? ["--", input.prompt] : []),
  ];
  return programLaunch(input.program ?? "claude", args, le);
}

const HookBase = z.object({ hook_event_name: z.string(), session_id: z.string().optional() }).loose();

const Questions = z.array(Question).min(1);

/** What a Claude terminal has learned from its hooks so far. */
export interface ClaudeHookState {
  engineSessionId?: string;
  model?: string;
}

/**
 * Handles one hook call. Returns the JSON body to send back, or undefined for an empty 200.
 *
 * Any hook may be the first one Loom sees: Claude Code holds hooks back until the folder is trusted,
 * so in a new folder `SessionStart` never arrives. The session id is therefore taken from every hook.
 */
export async function handleClaudeHook(
  payload: unknown,
  host: AdapterHost,
  cwd: string,
  signal: AbortSignal,
  known: ClaudeHookState = {},
): Promise<object | undefined> {
  const base = HookBase.safeParse(payload);
  if (!base.success) return undefined;
  const p = base.data as Record<string, unknown> & { hook_event_name: string; session_id?: string };

  const model = typeof p.model === "string" ? p.model : undefined;
  if (p.session_id && (p.session_id !== known.engineSessionId || (model && model !== known.model))) {
    known.engineSessionId = p.session_id;
    if (model) known.model = model;
    host.emit({ type: "session.engine", engineSessionId: p.session_id, ...(known.model ? { model: known.model } : {}) });
  }

  switch (p.hook_event_name) {
    case "SessionStart":
      host.emit({ type: "session.state", state: "idle", provenance: "pushed" });
      return undefined;

    case "UserPromptSubmit":
      if (typeof p.prompt === "string" && p.prompt.trim()) host.emit({ type: "user.message", text: p.prompt, from: "human" });
      host.emit({ type: "session.state", state: "working", provenance: "pushed" });
      return undefined;

    case "Stop":
      host.emit({ type: "session.state", state: "idle", provenance: "pushed" });
      return undefined;

    case "Notification":
      if (p.notification_type === "idle_prompt") host.emit({ type: "session.state", state: "idle", provenance: "pushed" });
      return undefined;

    case "PermissionRequest": {
      const toolName = typeof p.tool_name === "string" ? p.tool_name : "tool";
      const input = (p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {}) as Record<string, unknown>;
      const suggestions = Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [];
      const decision = await host.requestApproval(
        {
          kind: "permission",
          summary: approvalSummary(toolName, input, cwd),
          toolName,
          input,
          canAlwaysAllow: suggestions.length > 0,
          ...(ruleFromClaudeSuggestions(suggestions) ? { suggestedRule: ruleFromClaudeSuggestions(suggestions)! } : {}),
        },
        signal,
      );
      return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: permissionDecision(decision, suggestions) } };
    }

    case "PreToolUse": {
      if (p.tool_name !== "AskUserQuestion") return undefined;
      const input = (p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {}) as Record<string, unknown>;
      const questions = Questions.safeParse(input.questions);
      if (!questions.success) return undefined;
      const decision = await host.requestApproval(
        { kind: "question", summary: approvalSummary("AskUserQuestion", input, cwd), questions: questions.data },
        signal,
      );
      return { hookSpecificOutput: { hookEventName: "PreToolUse", ...questionDecision(decision, input) } };
    }

    default:
      return undefined;
  }
}

/** Loom decision to a PermissionRequest hook `decision` object. */
export function permissionDecision(decision: ApprovalDecision, suggestions: unknown[]): object {
  switch (decision.type) {
    case "allow":
    case "allow-rule":
      return { behavior: "allow" };
    case "allow-always":
      return { behavior: "allow", updatedPermissions: suggestions };
    case "allow-edited":
      return { behavior: "allow", updatedInput: decision.input };
    case "deny":
      return { behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) };
    default:
      return { behavior: "deny", message: "This approval was answered in a way that does not apply to a permission." };
  }
}

/** Loom decision to PreToolUse output for AskUserQuestion. */
export function questionDecision(decision: ApprovalDecision, input: Record<string, unknown>): object {
  switch (decision.type) {
    case "answer":
      return { permissionDecision: "allow", updatedInput: { ...input, answers: decision.answers } };
    case "reply":
      return { permissionDecision: "allow", updatedInput: { ...input, answers: {}, response: decision.text } };
    case "deny":
      return { permissionDecision: "deny", permissionDecisionReason: decision.message };
    default:
      return { permissionDecision: "deny", permissionDecisionReason: "The question was not answered." };
  }
}

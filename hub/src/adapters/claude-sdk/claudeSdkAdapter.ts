import {
  createSdkMcpServer,
  tool,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  query,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { type ApprovalDecision, type PermissionLevel, Question, type UserMessageSource } from "@loom/protocol";
import { z } from "zod";
import type { AdapterFactory, AdapterHost, AdapterStart, NewApproval, SessionAdapter } from "../../core/adapter.ts";
import { InputQueue } from "./inputQueue.ts";
import { permissionModeFor } from "./levels.ts";
import { mapMessage, type MapState } from "./mapMessage.ts";
import { approvalSummary, claudeProtectionRules, ruleFromClaudeSuggestions } from "./summary.ts";
import type { LoomIntegration } from "../../core/adapter.ts";
import { runTool } from "../../loom/tools.ts";
import { terminalBaseEnv } from "../../pty/locate.ts";

/** The loom tools as an in-process MCP server for the Agent SDK (ADR-0007). */
function loomServer(loom: LoomIntegration) {
  return createSdkMcpServer({
    name: "loom",
    instructions: loom.instructions,
    tools: loom.tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.shape as Record<string, never>,
        async (args: Record<string, unknown>) => {
          const result = await runTool(t, args, loom.api);
          return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
        },
        // Never deferred behind tool search: these are how the session reaches the hub.
        { alwaysLoad: true },
      ),
    ),
  });
}

const Questions = z.array(Question).min(1);

export interface ClaudeSdkAdapterOptions {
  /** Replaces the SDK's `query` in tests. */
  queryFn?: typeof query;
  /** Extra SDK options applied to every session, e.g. `pathToClaudeCodeExecutable`. */
  sdkOptions?: Partial<Options>;
}

/**
 * Runs a Claude session through the Claude Agent SDK in streaming-input mode (ADR-0005).
 * One instance per engine process; the manager creates a new one to resume.
 */
export class ClaudeSdkAdapter implements SessionAdapter {
  readonly kind = "claude-sdk" as const;
  #host: AdapterHost;
  #opts: ClaudeSdkAdapterOptions;
  #input = new InputQueue();
  #query: Query | undefined;
  #pump: Promise<void> | undefined;
  #stopping = false;
  #cwd = "";
  #stderr: string[] = [];

  constructor(host: AdapterHost, opts: ClaudeSdkAdapterOptions = {}) {
    this.#host = host;
    this.#opts = opts;
  }

  async start(start: AdapterStart): Promise<void> {
    const { spec, level, hubMax } = start;
    this.#cwd = spec.cwd;
    const mapState: MapState = { costBase: start.costBase };

    const loom = start.loom;
    const appended = [loom?.cockpitPrompt, spec.role ? `Your role in this session: ${spec.role}` : undefined].filter(Boolean).join("\n\n");
    const options: Options = {
      ...this.#opts.sdkOptions,
      ...(loom
        ? {
            env: { ...terminalBaseEnv(), ...loom.env },
            mcpServers: { loom: loomServer(loom) },
            // The hub authorizes each loom call by role, so they need no permission prompt.
            allowedTools: ["mcp__loom__*"],
          }
        : {}),
      cwd: spec.cwd,
      permissionMode: permissionModeFor(level),
      // Required by the SDK before bypassPermissions can ever be used; only where a person may choose "full".
      allowDangerouslySkipPermissions: hubMax === "full",
      canUseTool: this.#canUseTool,
      ...(start.protectedFiles.length ? { settings: { permissions: { ask: claudeProtectionRules(start.protectedFiles) } } } : {}),
      stderr: (data) => {
        this.#stderr.push(data);
        if (this.#stderr.length > 50) this.#stderr.shift();
      },
      ...(spec.model ? { model: spec.model } : {}),
      ...(start.resumeEngineSessionId ? { resume: start.resumeEngineSessionId } : {}),
      ...(appended ? { systemPrompt: { type: "preset", preset: "claude_code", append: appended } } : {}),
    };

    const q = (this.#opts.queryFn ?? query)({ prompt: this.#input, options });
    this.#query = q;
    this.#pump = this.#run(q, mapState);
  }

  async send(text: string, from: UserMessageSource): Promise<void> {
    this.#host.emit({ type: "session.state", state: "working", provenance: "pushed" });
    this.#input.push(text, from === "human" || from === "voice");
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#input.close();
    this.#query?.close();
    await this.#pump;
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    await this.#query?.setPermissionMode(permissionModeFor(level));
  }

  async #run(q: Query, mapState: MapState): Promise<void> {
    try {
      const debug = process.env.LOOM_DEBUG_SDK === "1";
      for await (const msg of q) {
        if (debug) console.error(`[sdk ${this.#host.sessionId.slice(0, 8)}]`, JSON.stringify(msg).slice(0, 2000));
        for (const event of mapMessage(msg, mapState)) this.#host.emit(event);
      }
      if (!this.#stopping) this.#host.exited();
    } catch (err) {
      if (this.#stopping) return;
      const tail = this.#stderr.join("").trim().split("\n").slice(-5).join("\n");
      const message = err instanceof Error ? err.message : String(err);
      this.#host.exited(tail ? `${message}\n${tail}` : message);
    }
  }

  #canUseTool: CanUseTool = async (toolName, input, opts) => {
    const summary = approvalSummary(toolName, input, this.#cwd, opts.title);
    const questions = toolName === "AskUserQuestion" ? Questions.safeParse(input.questions) : undefined;

    const request: NewApproval = questions?.success
      ? { kind: "question", summary, questions: questions.data }
      : {
          kind: "permission",
          summary,
          toolName,
          input,
          canAlwaysAllow: (opts.suggestions?.length ?? 0) > 0 && opts.suppressAlwaysAllowRule !== true,
          ...(ruleFromClaudeSuggestions(opts.suggestions) ? { suggestedRule: ruleFromClaudeSuggestions(opts.suggestions)! } : {}),
          ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
          ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
        };

    const decision = await this.#host.requestApproval(request, opts.signal);
    return toPermissionResult(decision, input, opts.suggestions);
  };
}

/** Loom decision to the SDK's permission result. */
export function toPermissionResult(
  decision: ApprovalDecision,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  switch (decision.type) {
    case "allow":
    case "allow-rule":
      return { behavior: "allow", updatedInput: input };
    case "allow-always":
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions ?? [] };
    case "allow-edited":
      return { behavior: "allow", updatedInput: decision.input };
    case "deny":
      return { behavior: "deny", message: decision.message, ...(decision.interrupt ? { interrupt: true } : {}) };
    case "answer":
      return { behavior: "allow", updatedInput: { ...input, answers: decision.answers } };
    case "reply":
      return { behavior: "allow", updatedInput: { ...input, answers: {}, response: decision.text } };
  }
}

export function claudeSdkFactory(opts: ClaudeSdkAdapterOptions = {}): AdapterFactory {
  return (host) => new ClaudeSdkAdapter(host, opts);
}

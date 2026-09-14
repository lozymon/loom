import type {
  AdapterKind,
  ApprovalDecision,
  ApprovalRequest,
  PermissionLevel,
  SessionEvent,
  SessionId,
  SessionSpec,
  UserMessageSource,
} from "@loom/protocol";

/** A hub request a Loom tool makes on behalf of its session. */
export interface LoomApi {
  request<N extends import("@loom/protocol").CommandName>(
    cmd: import("@loom/protocol").CommandOf<N>,
  ): Promise<import("@loom/protocol").CommandResults[N]>;
}

/** One coordination tool, defined once and exposed by whichever transport an engine supports (ADR-0007). */
export interface LoomTool {
  name: string;
  description: string;
  /** zod raw shape for the arguments. */
  shape: Record<string, import("zod").ZodType>;
  run(args: Record<string, unknown>, api: LoomApi): Promise<string>;
}

/** How a session reaches the hub: environment for its processes, and tools for engines that take them. */
export interface LoomIntegration {
  role: "session" | "cockpit";
  /** LOOM_HUB_URL, LOOM_SESSION_ID, LOOM_SESSION_TOKEN, and PATH with the `loom` command. */
  env: Record<string, string>;
  tools: LoomTool[];
  /** In-process access for engines that host tools in the hub process. */
  api: LoomApi;
  /** A stdio MCP server command for engines that launch their own (Claude terminals). */
  stdio: { command: string; args: string[] };
  /** Short guidance attached to the tools. */
  instructions: string;
  /** Extra system prompt for the Cockpit. */
  cockpitPrompt?: string;
}

/** An approval as an adapter raises it. The broker adds id, session, and timestamp. */
export type NewApproval =
  | Omit<Extract<ApprovalRequest, { kind: "permission" }>, "id" | "sessionId" | "requestedAt">
  | Omit<Extract<ApprovalRequest, { kind: "question" }>, "id" | "sessionId" | "requestedAt">;

/** What the session manager gives an adapter. One host per adapter instance. */
export interface AdapterHost {
  readonly sessionId: SessionId;
  /**
   * Publish an engine event. Adapters emit engine facts: state, engine identity, messages, tools,
   * cost. The manager emits the rest: creation, user messages, level, liveness, approvals.
   */
  emit(event: SessionEvent): void;
  /**
   * Ask for a decision and wait for it. The manager marks the session blocked while any request is
   * open. Aborting `signal` cancels the request.
   */
  requestApproval(request: NewApproval, signal?: AbortSignal): Promise<ApprovalDecision>;
  /** The engine stopped on its own. `error` is set when it was not a clean exit. The session stays resumable. */
  exited(error?: string): void;
  /** The session's process finished and the session is over until restarted (terminal sessions). */
  ended(outcome: "done" | "error", message?: string): void;
  /** Terminal bytes. Kept in the session's terminal buffer and streamed to attached clients, never logged. */
  terminalOutput(bytes: Buffer): void;
}

export interface AdapterStart {
  spec: SessionSpec;
  level: PermissionLevel;
  hubMax: PermissionLevel;
  /** Set when restarting an existing engine session. */
  resumeEngineSessionId?: string | undefined;
  /** Session cost so far, so cost.update stays a session total across restarts. */
  costBase: number;
  /** Files the engine must not change without a person, such as Loom policy (M4). */
  protectedFiles: string[];
  /** Loom tools and environment for this launch (M6). */
  loom?: LoomIntegration | undefined;
}

/**
 * Runs one session on one engine (ADR-0004). Created per start; a stopped adapter is discarded and
 * a new one created on resume.
 */
export interface SessionAdapter {
  readonly kind: AdapterKind;
  start(opts: AdapterStart): Promise<void>;
  send(text: string, from: UserMessageSource): Promise<void>;
  interrupt(): Promise<void>;
  /** Stop the engine and resolve once it has fully exited. Must not call host.exited. */
  stop(): Promise<void>;
  setLevel(level: PermissionLevel): Promise<void>;

  /** True when the session is over once its process exits, instead of paused and resumable. */
  readonly endsWithProcess?: boolean;
  /** Terminal input. Present on adapters that run a terminal. */
  write?(bytes: Uint8Array): void;
  resize?(cols: number, rows: number): void;
  /**
   * An integration callback from the running engine, e.g. a Claude Code HTTP hook. Returns the
   * response body. Throws an error with `status: 401` for a bad token.
   */
  hook?(token: string | undefined, payload: unknown, signal: AbortSignal): Promise<object | undefined>;
}

export type AdapterFactory = (host: AdapterHost) => SessionAdapter;

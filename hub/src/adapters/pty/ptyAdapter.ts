import type { PermissionLevel, UserMessageSource } from "@loom/protocol";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { AdapterFactory, AdapterHost, AdapterStart, SessionAdapter } from "../../core/adapter.ts";
import type { PtySidecar } from "../../pty/sidecar.ts";
import { CLAUDE_AGENT, type ClaudeHookState, claudeLaunch, handleClaudeHook } from "./claudeTerminal.ts";
import { type Launch, type LaunchEnv, shellLaunch } from "./launch.ts";

export interface PtyAdapterOptions {
  sidecar(): Promise<PtySidecar>;
  /** URL Claude Code posts hooks to for this session, e.g. http://127.0.0.1:7420/hooks/<id>. */
  hookUrl(sessionId: string): string;
  /** Where per-session files such as hook settings go. */
  sessionDir(sessionId: string): string;
  hubUrl(): string;
  launchEnv?: LaunchEnv;
  /** The Claude Code executable; `claude` found through the login shell unless set. */
  claudeProgram?: string;
}

const DEFAULT_SIZE = { cols: 100, rows: 30 };
const STOP_TIMEOUT_MS = 3000;

/**
 * Runs a session as a real terminal (ADR-0004). Bytes are opaque; state comes from hooks when the
 * session runs a known agent, and from the process's exit otherwise.
 */
export class PtyAdapter implements SessionAdapter {
  readonly kind = "pty" as const;
  readonly endsWithProcess = true;
  #host: AdapterHost;
  #opts: PtyAdapterOptions;
  #sidecar: PtySidecar | undefined;
  #id: number | undefined;
  #exited: Promise<void> | undefined;
  #cwd = "";
  #agent: string | undefined;
  #hookToken = randomBytes(24).toString("base64url");
  #hookState: ClaudeHookState = {};

  constructor(host: AdapterHost, opts: PtyAdapterOptions) {
    this.#host = host;
    this.#opts = opts;
  }

  async start(start: AdapterStart): Promise<void> {
    const { spec } = start;
    const le = this.#opts.launchEnv ?? { platform: process.platform, env: process.env };
    this.#cwd = spec.cwd;
    this.#agent = spec.agent;
    if (start.resumeEngineSessionId) this.#hookState.engineSessionId = start.resumeEngineSessionId;

    let launch: Launch;
    if (spec.agent === undefined) {
      launch = shellLaunch(spec.command, le);
    } else if (spec.agent === CLAUDE_AGENT) {
      launch = claudeLaunch(
        {
          settingsFile: path.join(this.#opts.sessionDir(this.#host.sessionId), "claude-settings.json"),
          hookUrl: this.#opts.hookUrl(this.#host.sessionId),
          resumeEngineSessionId: start.resumeEngineSessionId,
          model: spec.model,
          level: start.level,
          hubMax: start.hubMax,
          program: this.#opts.claudeProgram,
          protectedFiles: start.protectedFiles,
          prompt: spec.prompt,
          ...(start.loom ? { mcpServer: start.loom.stdio } : {}),
        },
        le,
      );
    } else {
      throw new Error(`unknown terminal agent "${spec.agent}"`);
    }

    const sidecar = await this.#opts.sidecar();
    let resolveExit!: () => void;
    this.#exited = new Promise((r) => (resolveExit = r));
    const { id } = await sidecar.spawn(
      {
        program: launch.program,
        args: launch.args,
        cwd: spec.cwd,
        cols: spec.terminal?.cols ?? DEFAULT_SIZE.cols,
        rows: spec.terminal?.rows ?? DEFAULT_SIZE.rows,
        env: {
          ...(le.platform === "win32" ? {} : { TERM: "xterm-256color", COLORTERM: "truecolor" }),
          LOOM_SESSION_ID: this.#host.sessionId,
          LOOM_HUB_URL: this.#opts.hubUrl(),
          ...(start.loom?.env ?? {}),
          ...(this.#agent ? { LOOM_HOOK_TOKEN: this.#hookToken } : {}),
        },
      },
      {
        output: (bytes) => this.#host.terminalOutput(bytes),
        exit: (code, reason) => {
          this.#id = undefined;
          resolveExit();
          this.#host.emit({ type: "terminal.exit", code });
          this.#host.ended(
            code === 0 ? "done" : "error",
            reason ?? (code === 0 ? "exited" : `exited with code ${code}`),
          );
        },
      },
    );
    this.#sidecar = sidecar;
    this.#id = id;
    // Idle until an agent's hooks say otherwise; a trust prompt can hold those hooks back indefinitely.
    this.#host.emit({ type: "session.state", state: "idle", provenance: "hub" });
    this.#host.emit({ type: "session.process", command: launch.display, ...(this.#agent ? { agent: this.#agent } : {}) });
  }

  /** Types the text and presses Enter, as a person would. */
  async send(text: string, _from: UserMessageSource): Promise<void> {
    this.write(Buffer.from(`${text}\r`, "utf8"));
  }

  async interrupt(): Promise<void> {
    this.write(Buffer.from([0x03]));
  }

  async stop(): Promise<void> {
    if (this.#id === undefined || !this.#sidecar) return;
    this.#sidecar.kill(this.#id);
    await Promise.race([this.#exited, new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS))]);
  }

  /** Terminal sessions take their level at launch; a change applies on the next restart. */
  async setLevel(_level: PermissionLevel): Promise<void> {}

  write(bytes: Uint8Array): void {
    if (this.#id !== undefined) this.#sidecar?.write(this.#id, bytes);
  }

  resize(cols: number, rows: number): void {
    if (this.#id !== undefined) this.#sidecar?.resize(this.#id, cols, rows);
  }

  async hook(token: string | undefined, payload: unknown, signal: AbortSignal): Promise<object | undefined> {
    if (!this.#agent || !sameToken(token, this.#hookToken)) throw Object.assign(new Error("bad hook token"), { status: 401 });
    return handleClaudeHook(payload, this.#host, this.#cwd, signal, this.#hookState);
  }
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function ptyFactory(opts: PtyAdapterOptions): AdapterFactory {
  return (host) => new PtyAdapter(host, opts);
}

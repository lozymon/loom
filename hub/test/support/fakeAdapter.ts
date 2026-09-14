import type { ApprovalDecision, PermissionLevel, UserMessageSource } from "@loom/protocol";
import type { AdapterFactory, AdapterHost, AdapterStart, NewApproval, SessionAdapter } from "../../src/core/adapter.ts";

/**
 * A scripted adapter for hub tests. Tests reach the latest instance through the controller and
 * drive it like an engine would.
 */
export class FakeAdapter implements SessionAdapter {
  readonly kind = "claude-sdk" as const;
  readonly host: AdapterHost;
  started?: AdapterStart;
  sent: Array<{ text: string; from: UserMessageSource }> = [];
  levels: PermissionLevel[] = [];
  interrupted = 0;
  stopped = false;
  failStart?: string;

  constructor(host: AdapterHost) {
    this.host = host;
  }

  async start(opts: AdapterStart): Promise<void> {
    if (this.failStart) throw new Error(this.failStart);
    this.started = opts;
    if (opts.resumeEngineSessionId === undefined) {
      this.host.emit({ type: "session.engine", engineSessionId: `engine-${this.host.sessionId}`, model: "fake-model" });
    }
  }

  async send(text: string, from: UserMessageSource): Promise<void> {
    this.sent.push({ text, from });
    this.host.emit({ type: "session.state", state: "working", provenance: "pushed" });
  }

  async interrupt(): Promise<void> {
    this.interrupted++;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async setLevel(level: PermissionLevel): Promise<void> {
    this.levels.push(level);
  }

  // test drivers ----------------------------------------------------------

  reply(text: string, costUsd: number): void {
    this.host.emit({ type: "assistant.text", messageId: `m${Math.random()}`, text });
    this.host.emit({ type: "cost.update", costUsd });
    this.host.emit({ type: "session.state", state: "idle", provenance: "pushed" });
  }

  ask(request: NewApproval, signal?: AbortSignal): Promise<ApprovalDecision> {
    return this.host.requestApproval(request, signal);
  }
}

export function fakeFactory(options: { failStart?: string } = {}) {
  const instances: FakeAdapter[] = [];
  const factory: AdapterFactory = (host) => {
    const a = new FakeAdapter(host);
    if (options.failStart) a.failStart = options.failStart;
    instances.push(a);
    return a;
  };
  return {
    factory,
    instances,
    latest(): FakeAdapter {
      const a = instances.at(-1);
      if (!a) throw new Error("no adapter started");
      return a;
    },
  };
}

export const bashApproval: NewApproval = {
  kind: "permission",
  summary: "Run: npm test",
  toolName: "Bash",
  input: { command: "npm test" },
  canAlwaysAllow: true,
};

export const colorQuestion: NewApproval = {
  kind: "question",
  summary: "Red or Blue?",
  questions: [
    {
      question: "Red or Blue?",
      options: [{ label: "Red" }, { label: "Blue" }],
      multiSelect: false,
    },
  ],
};

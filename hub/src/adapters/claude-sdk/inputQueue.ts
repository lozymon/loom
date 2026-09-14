import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * A push-driven async iterable of user messages, handed to the SDK as its prompt so one engine
 * process stays open across turns. Pattern proven in tools/sdk-smoke step 7.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(text: string, human: boolean): void {
    if (this.#closed) throw new Error("input queue is closed");
    this.#pending.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      // Claude Code treats messages without an origin as unattributed; a person's input must say so.
      ...(human ? { origin: { kind: "human" } } : {}),
    });
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

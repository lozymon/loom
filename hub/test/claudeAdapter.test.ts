import type { CanUseTool, Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeSdkFactory } from "../src/adapters/claude-sdk/claudeSdkAdapter.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { EventLog } from "../src/log/eventLog.ts";
import { flush } from "./support/hub.ts";

/**
 * A stand-in for the SDK's query(): for each user message it runs `script`, which may call
 * canUseTool and yields SDK messages back.
 */
function fakeQuery(script: (text: string, canUseTool: CanUseTool) => AsyncGenerator<unknown>) {
  const calls: { options: Options; modes: string[]; closed: boolean; interrupted: number } = {
    options: {},
    modes: [],
    closed: false,
    interrupted: 0,
  };
  const fn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    calls.options = params.options;
    async function* run(): AsyncGenerator<SDKMessage> {
      for await (const user of params.prompt) {
        if (calls.closed) return;
        const text = String(user.message.content);
        for await (const m of script(text, params.options.canUseTool!)) yield m as SDKMessage;
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: async () => {
        calls.interrupted++;
        return undefined;
      },
      close: () => {
        calls.closed = true;
      },
      setPermissionMode: async (mode: string) => {
        calls.modes.push(mode);
      },
    });
  }) as unknown as typeof query;
  return { fn, calls };
}

function hubWith(queryFn: typeof query, maxLevel: "accept-edits" | "full" = "accept-edits") {
  const log = new EventLog(":memory:", "t");
  let n = 0;
  const manager = new SessionManager({
    log,
    defaultLevel: "supervised",
    maxLevel,
    adapters: { "claude-sdk": claudeSdkFactory({ queryFn }) },
    newId: () => `id${++n}`,
    isDirectory: () => true,
  });
  manager.init();
  return { manager, log };
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ClaudeSdkAdapter with a scripted SDK", () => {
  it("runs a turn with an approval end to end", async () => {
    const { fn, calls } = fakeQuery(async function* (text, canUseTool) {
      yield { type: "system", subtype: "init", session_id: "uuid-9", model: "claude-opus-5", plugins: [], mcp_servers: [] };
      const verdict = await canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal, suggestions: [], toolUseID: "toolu_1", requestId: "r1" });
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", content: [{ type: "text", text: `${text}: ${verdict?.behavior}` }] },
      };
      yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.05 };
    });
    const { manager } = hubWith(fn);
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/home/kim/repo", prompt: "go", role: "reviewer" });

    await until(() => manager.approvals().length === 1);
    expect(manager.get(s.id)).toMatchObject({ state: "blocked", blockedOn: "approval" });
    expect(manager.approvals()[0]).toMatchObject({ kind: "permission", summary: "Run: npm test", canAlwaysAllow: false });

    manager.decide(manager.approvals()[0]!.id, { type: "allow" });
    await until(() => manager.get(s.id).state === "idle");

    const summary = manager.get(s.id);
    expect(summary).toMatchObject({ engineSessionId: "uuid-9", model: "claude-opus-5", costUsd: 0.05, live: true });
    const texts = manager.read(s.id).flatMap((e) => (e.event.type === "assistant.text" ? [e.event.text] : []));
    expect(texts).toEqual(["go: allow"]);
    expect(calls.options).toMatchObject({
      cwd: "/home/kim/repo",
      permissionMode: "default",
      allowDangerouslySkipPermissions: false,
      systemPrompt: { type: "preset", preset: "claude_code", append: "Your role in this session: reviewer" },
    });
  });

  it("routes AskUserQuestion to a question approval and returns the answers", async () => {
    let answered: unknown;
    const { fn } = fakeQuery(async function* (_text, canUseTool) {
      const r = await canUseTool(
        "AskUserQuestion",
        { questions: [{ question: "Red or Blue?", header: "Color", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false }] },
        { signal: new AbortController().signal, toolUseID: "toolu_2", requestId: "r2" },
      );
      answered = r;
      yield { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0 };
    });
    const { manager } = hubWith(fn);
    await manager.create({ adapter: "claude-sdk", cwd: "/r", prompt: "ask me" });
    await until(() => manager.approvals().length === 1);
    const [q] = manager.approvals();
    expect(q).toMatchObject({ kind: "question", summary: "Red or Blue?" });

    manager.decide(q!.id, { type: "answer", answers: { "Red or Blue?": "Blue" } });
    await until(() => answered !== undefined);
    expect(answered).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Red or Blue?": "Blue" } } });
  });

  it("applies level changes to the live engine and allows bypass only when the hub max is full", async () => {
    const { fn, calls } = fakeQuery(async function* () {});
    const { manager } = hubWith(fn, "full");
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/r" });
    expect(calls.options.allowDangerouslySkipPermissions).toBe(true);
    await manager.setLevel(s.id, "accept-edits", "human");
    expect(calls.modes).toEqual(["acceptEdits"]);
  });

  it("reports an engine that dies as idle and resumable, with the error", async () => {
    const { fn } = fakeQuery(async function* () {
      throw new Error("claude exited with code 1");
    });
    const { manager } = hubWith(fn);
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/r", prompt: "go" });
    await until(() => !manager.get(s.id).live);
    await flush();
    expect(manager.get(s.id).state).toBe("idle");
    const errors = manager.read(s.id).filter((e) => e.event.type === "error");
    expect(errors[0]?.event).toMatchObject({ message: expect.stringContaining("exited with code 1") });
  });

  it("stops cleanly without reporting an exit", async () => {
    const { fn, calls } = fakeQuery(async function* () {});
    const { manager } = hubWith(fn);
    const s = await manager.create({ adapter: "claude-sdk", cwd: "/r" });
    await manager.stop(s.id);
    expect(calls.closed).toBe(true);
    expect(manager.read(s.id).filter((e) => e.event.type === "error")).toEqual([]);
    expect(manager.get(s.id)).toMatchObject({ live: false, state: "idle" });
  });
});

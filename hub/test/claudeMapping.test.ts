import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toPermissionResult } from "../src/adapters/claude-sdk/claudeSdkAdapter.ts";
import { permissionModeFor } from "../src/adapters/claude-sdk/levels.ts";
import { mapMessage, type MapState } from "../src/adapters/claude-sdk/mapMessage.ts";
import { approvalSummary } from "../src/adapters/claude-sdk/summary.ts";

const msg = (m: unknown) => m as SDKMessage;

const init = (sessionId = "uuid-1") =>
  msg({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-opus-5",
    plugins: [{ name: "frontend-design", path: "/p" }],
    mcp_servers: [{ name: "gmail", status: "needs-auth" }],
  });

describe("mapMessage", () => {
  it("publishes engine identity once, and again only when it changes", () => {
    const state: MapState = { costBase: 0 };
    expect(mapMessage(init(), state)).toEqual([
      {
        type: "session.engine",
        engineSessionId: "uuid-1",
        model: "claude-opus-5",
        loaded: { plugins: ["frontend-design"], mcpServers: [{ name: "gmail", status: "needs-auth" }] },
      },
    ]);
    expect(mapMessage(init(), state)).toEqual([]);
    expect(mapMessage(init("uuid-2"), state)).toHaveLength(1);
  });

  it("splits assistant content into text, thinking, and tool uses, skipping empty blocks", () => {
    const events = mapMessage(
      msg({
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: {
          id: "msg_1",
          content: [
            { type: "thinking", thinking: "" },
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "Running tests." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
      { costBase: 0 },
    );
    expect(events).toEqual([
      { type: "assistant.thinking", messageId: "msg_1:1", text: "considering" },
      { type: "assistant.text", messageId: "msg_1:2", text: "Running tests.", parentToolUseId: "toolu_parent" },
      { type: "tool.use", toolUseId: "toolu_1", toolName: "Bash", input: { command: "npm test" }, parentToolUseId: "toolu_parent" },
    ]);
  });

  it("maps tool results and ignores replayed user messages", () => {
    const result = msg({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: [{ type: "text", text: "boom" }] }],
      },
    });
    expect(mapMessage(result, { costBase: 0 })).toEqual([
      { type: "tool.result", toolUseId: "toolu_1", isError: true, preview: "boom" },
    ]);
    expect(mapMessage(msg({ ...(result as object), isReplay: true }), { costBase: 0 })).toEqual([]);
  });

  it("truncates long tool output", () => {
    const [e] = mapMessage(
      msg({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(5000) }] } }),
      { costBase: 0 },
    );
    expect(e).toMatchObject({ type: "tool.result", isError: false });
    expect((e as { preview: string }).preview.length).toBeLessThan(2100);
  });

  it("turns a result into a session-total cost and idle, adding the base from before a resume", () => {
    expect(mapMessage(msg({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.3 }), { costBase: 1.2 })).toEqual([
      { type: "cost.update", costUsd: 1.5 },
      { type: "session.state", state: "idle", provenance: "pushed" },
    ]);
  });

  it("reports failed turns as errors but still goes idle", () => {
    const events = mapMessage(
      msg({ type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0, errors: [] }),
      { costBase: 0 },
    );
    expect(events.map((e) => e.type)).toEqual(["cost.update", "error", "session.state"]);
  });
});

describe("approvalSummary", () => {
  const cwd = path.join("/home/kim/repo");
  it.each([
    ["Bash", { command: "npm   test\n--watch" }, "Run: npm test --watch"],
    ["Write", { file_path: path.join("/home/kim/repo", "src", "app.ts") }, `Write ${path.join("src", "app.ts")}`],
    ["Edit", { file_path: "/etc/hosts" }, "Edit /etc/hosts"],
    ["WebFetch", { url: "https://example.com" }, "Fetch https://example.com"],
    ["AskUserQuestion", { questions: [{ question: "Red or Blue?" }] }, "Red or Blue?"],
    ["mcp__github__create_issue", {}, "Use create_issue from github"],
    ["Mystery", {}, "Use Mystery"],
  ])("%s", (tool, input, expected) => {
    expect(approvalSummary(tool, input, cwd)).toBe(expected);
  });

  it("prefers a non-empty engine title and clips long commands", () => {
    expect(approvalSummary("Bash", { command: "ls" }, cwd, "Claude wants to list files")).toBe("Claude wants to list files");
    expect(approvalSummary("Bash", { command: "ls" }, cwd, "")).toBe("Run: ls");
    expect(approvalSummary("Bash", { command: "x".repeat(300) }, cwd).length).toBe(120);
  });
});

describe("toPermissionResult", () => {
  const input = { command: "npm test" };
  const suggestion = [{ type: "addRules", rules: [], behavior: "allow", destination: "localSettings" }] as never;

  it("maps every decision type", () => {
    expect(toPermissionResult({ type: "allow" }, input, suggestion)).toEqual({ behavior: "allow", updatedInput: input });
    expect(toPermissionResult({ type: "allow-always" }, input, suggestion)).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: suggestion,
    });
    expect(toPermissionResult({ type: "allow-edited", input: { command: "npm test -- --ci" } }, input, undefined)).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test -- --ci" },
    });
    expect(toPermissionResult({ type: "deny", message: "no", interrupt: true }, input, undefined)).toEqual({
      behavior: "deny",
      message: "no",
      interrupt: true,
    });
  });

  it("passes question answers and free-text replies back in the tool input", () => {
    const q = { questions: [{ question: "Red or Blue?" }] };
    expect(toPermissionResult({ type: "answer", answers: { "Red or Blue?": "Blue" } }, q, undefined)).toEqual({
      behavior: "allow",
      updatedInput: { ...q, answers: { "Red or Blue?": "Blue" } },
    });
    expect(toPermissionResult({ type: "reply", text: "neither" }, q, undefined)).toEqual({
      behavior: "allow",
      updatedInput: { ...q, answers: {}, response: "neither" },
    });
  });
});

describe("permissionModeFor", () => {
  it("maps levels to Claude Code modes", () => {
    expect(["supervised", "accept-edits", "assisted", "full"].map((l) => permissionModeFor(l as never))).toEqual([
      "default",
      "acceptEdits",
      "default",
      "bypassPermissions",
    ]);
  });
});

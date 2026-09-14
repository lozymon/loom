import type { ApprovalDecision, SessionEvent } from "@loom/protocol";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeLaunch, handleClaudeHook, hookSettings, permissionDecision, questionDecision } from "../src/adapters/pty/claudeTerminal.ts";
import type { AdapterHost, NewApproval } from "../src/core/adapter.ts";

function fakeHost(decision: ApprovalDecision = { type: "allow" }) {
  const events: SessionEvent[] = [];
  const approvals: NewApproval[] = [];
  const host: AdapterHost = {
    sessionId: "s1",
    emit: (e) => events.push(e),
    requestApproval: async (r) => {
      approvals.push(r);
      return decision;
    },
    exited: () => {},
    ended: () => {},
    terminalOutput: () => {},
  };
  return { host, events, approvals };
}

const signal = new AbortController().signal;

describe("hookSettings", () => {
  it("routes every hook to one URL with a token taken from the environment, never inlined", () => {
    const settings = hookSettings("http://127.0.0.1:7420/hooks/s1") as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["Notification", "PermissionRequest", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    const all = Object.values(settings.hooks).flatMap((m) => m.flatMap((x) => x.hooks));
    for (const h of all) {
      expect(h).toMatchObject({ type: "http", url: "http://127.0.0.1:7420/hooks/s1", allowedEnvVars: ["LOOM_HOOK_TOKEN"] });
      expect(JSON.stringify(h)).toContain("$LOOM_HOOK_TOKEN");
    }
    expect(settings.hooks.PreToolUse![0]!.matcher).toBe("AskUserQuestion");
    expect(settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBeGreaterThanOrEqual(600);
  });
});

describe("handleClaudeHook", () => {
  it("learns the Claude session id and model at start, then tracks working and idle", async () => {
    const { host, events } = fakeHost();
    const known = {};
    await handleClaudeHook({ hook_event_name: "SessionStart", session_id: "uuid-1", model: "claude-opus-5" }, host, "/r", signal, known);
    await handleClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "uuid-1", prompt: "fix it" }, host, "/r", signal, known);
    await handleClaudeHook({ hook_event_name: "Stop", session_id: "uuid-1" }, host, "/r", signal, known);
    expect(events).toEqual([
      { type: "session.engine", engineSessionId: "uuid-1", model: "claude-opus-5" },
      { type: "session.state", state: "idle", provenance: "pushed" },
      { type: "user.message", text: "fix it", from: "human" },
      { type: "session.state", state: "working", provenance: "pushed" },
      { type: "session.state", state: "idle", provenance: "pushed" },
    ]);
  });

  it("turns a permission request into a Loom approval and answers with a decision object", async () => {
    const { host, approvals } = fakeHost({ type: "allow-always" });
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" };
    const out = await handleClaudeHook(
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" }, permission_suggestions: [suggestion] },
      host,
      "/r",
      signal,
    );
    expect(approvals[0]).toMatchObject({ kind: "permission", summary: "Run: npm test", canAlwaysAllow: true });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: [suggestion] } } });
  });

  it("answers AskUserQuestion through PreToolUse with the chosen answers", async () => {
    const { host, approvals } = fakeHost({ type: "answer", answers: { "Red or Blue?": "Blue" } });
    const input = { questions: [{ question: "Red or Blue?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] };
    const out = await handleClaudeHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: input }, host, "/r", signal);
    expect(approvals[0]).toMatchObject({ kind: "question" });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input, answers: { "Red or Blue?": "Blue" } } },
    });
  });

  it("learns the session id from any hook, once, when SessionStart was held back", async () => {
    const { host, events } = fakeHost();
    const known = {};
    await handleClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "uuid-2", prompt: "hi" }, host, "/r", signal, known);
    await handleClaudeHook({ hook_event_name: "Stop", session_id: "uuid-2" }, host, "/r", signal, known);
    expect(events.filter((e) => e.type === "session.engine")).toEqual([{ type: "session.engine", engineSessionId: "uuid-2" }]);
  });

  it("ignores other tools on PreToolUse and unknown events", async () => {
    const { host, events, approvals } = fakeHost();
    expect(await handleClaudeHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, host, "/r", signal)).toBeUndefined();
    expect(await handleClaudeHook({ hook_event_name: "Whatever" }, host, "/r", signal)).toBeUndefined();
    expect(await handleClaudeHook("not an object", host, "/r", signal)).toBeUndefined();
    expect([events, approvals]).toEqual([[], []]);
  });
});

describe("decision mapping", () => {
  it("maps denials for permissions and questions", () => {
    expect(permissionDecision({ type: "deny", message: "no", interrupt: true }, [])).toEqual({ behavior: "deny", message: "no", interrupt: true });
    expect(permissionDecision({ type: "allow-edited", input: { command: "ls" } }, [])).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(questionDecision({ type: "deny", message: "later" }, {})).toEqual({ permissionDecision: "deny", permissionDecisionReason: "later" });
  });
});

describe("claudeLaunch", () => {
  it("writes protection ask rules into the settings file and starts a fresh session with its prompt", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-launch-"));
    try {
      const settingsFile = path.join(dir, "s.json");
      const le = { platform: "linux" as const, env: { SHELL: "/bin/sh" }, exists: (p: string) => p === "/bin/sh" };
      const launch = claudeLaunch(
        { settingsFile, hookUrl: "http://127.0.0.1:1/hooks/s", level: "supervised", hubMax: "accept-edits", protectedFiles: ["/repo/.loom/policy.json"], prompt: "-fix the build" },
        le,
      );
      expect(JSON.parse(readFileSync(settingsFile, "utf8")).permissions).toEqual({ ask: ["Edit(//repo/.loom/policy.json)"] });
      expect(launch.args[2]).toMatch(/ -- '-fix the build'$/);
      const resumed = claudeLaunch({ settingsFile, hookUrl: "u", level: "supervised", hubMax: "accept-edits", resumeEngineSessionId: "abc", prompt: "ignored" }, le);
      expect(resumed.args[2]).not.toContain("ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

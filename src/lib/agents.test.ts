import { describe, expect, it } from "vitest";
import { detectAgent, resumeClaudeCommand, agentUsesHeuristics } from "./agents";

describe("detectAgent", () => {
  it("returns null for a plain shell or no command", () => {
    expect(detectAgent(undefined)).toBeNull();
    expect(detectAgent("")).toBeNull();
    expect(detectAgent("bash")).toBeNull();
    expect(detectAgent("npm run dev")).toBeNull();
  });

  it("identifies a bare agent command", () => {
    expect(detectAgent("claude")?.id).toBe("claude");
    expect(detectAgent("codex")?.id).toBe("codex");
    expect(detectAgent("gemini")?.id).toBe("gemini");
    expect(detectAgent("aider")?.id).toBe("aider");
  });

  it("matches the program word despite flags, args, or a leading path", () => {
    expect(detectAgent("claude --resume")?.id).toBe("claude");
    expect(detectAgent("/usr/bin/codex --foo bar")?.id).toBe("codex");
    expect(detectAgent("npx aider --model gpt-4o")?.id).toBe("aider");
  });

  it("handles multi-word and prefixed commands", () => {
    expect(detectAgent("q chat")?.id).toBe("q");
    expect(detectAgent("gh copilot")?.id).toBe("copilot");
    expect(detectAgent("copilot suggest")?.id).toBe("copilot");
    expect(detectAgent("cursor-agent")?.id).toBe("cursor");
  });

  it("does not match a substring inside an unrelated word", () => {
    expect(detectAgent("claudette")).toBeNull();
    expect(detectAgent("qchat")).toBeNull();
    expect(detectAgent("./codexample")).toBeNull();
  });
});

describe("resumeClaudeCommand", () => {
  const newId = () => "fixed-uuid";
  const on = { enabled: true, newId };

  it("pins a fresh session id on a Claude pane's first run", () => {
    expect(resumeClaudeCommand({ command: "claude" }, on)).toEqual({
      command: "claude --session-id fixed-uuid",
      sessionId: "fixed-uuid",
    });
  });

  it("preserves the user's own flags when pinning", () => {
    expect(resumeClaudeCommand({ command: "claude --model opus" }, on)).toEqual({
      command: "claude --model opus --session-id fixed-uuid",
      sessionId: "fixed-uuid",
    });
  });

  it("reattaches with --resume once a session id is pinned and its transcript exists", () => {
    expect(resumeClaudeCommand({ command: "claude", sessionId: "abc" }, { ...on, sessionExists: true })).toEqual({
      command: "claude --resume abc",
      sessionId: "abc",
    });
  });

  it("re-pins the same id with --session-id when the pinned session has no transcript yet", () => {
    // Pinned last run but never conversed in (e.g. trust dialog) → nothing to --resume.
    expect(resumeClaudeCommand({ command: "claude", sessionId: "abc" }, { ...on, sessionExists: false })).toEqual({
      command: "claude --session-id abc",
      sessionId: "abc",
    });
  });

  it("leaves non-Claude panes untouched", () => {
    expect(resumeClaudeCommand({ command: "codex" }, on)).toEqual({ command: "codex", sessionId: undefined });
    expect(resumeClaudeCommand({ command: "bash" }, on)).toEqual({ command: "bash", sessionId: undefined });
  });

  it("leaves a plain shell (no command) untouched", () => {
    expect(resumeClaudeCommand({}, on)).toEqual({ command: undefined, sessionId: undefined });
  });

  it("does not double-manage when the user already set a session/resume flag", () => {
    for (const command of ["claude --continue", "claude -c", "claude --resume xyz", "claude --session-id mine", "claude -r"]) {
      expect(resumeClaudeCommand({ command }, on)).toEqual({ command, sessionId: undefined });
    }
  });

  it("does nothing at all when resume is disabled", () => {
    expect(resumeClaudeCommand({ command: "claude" }, { enabled: false, newId })).toEqual({
      command: "claude",
      sessionId: undefined,
    });
    // even an already-pinned pane is left as-is (launches resume only while the feature is on)
    expect(resumeClaudeCommand({ command: "claude", sessionId: "abc" }, { enabled: false, newId })).toEqual({
      command: "claude",
      sessionId: "abc",
    });
  });
});

describe("agentUsesHeuristics (ADR-0011 per-kind opt-in)", () => {
  it("is on for hookless kinds whose floor is thin", () => {
    for (const cmd of ["codex", "aider", "gemini", "copilot", "q chat", "cursor-agent --foo"]) {
      expect(agentUsesHeuristics(cmd)).toBe(true);
    }
  });

  it("is off for Claude (it self-reports richly) and for non-agents", () => {
    expect(agentUsesHeuristics("claude")).toBe(false);
    expect(agentUsesHeuristics("claude --resume x")).toBe(false);
    expect(agentUsesHeuristics("bash")).toBe(false);
    expect(agentUsesHeuristics("npm run dev")).toBe(false);
    expect(agentUsesHeuristics("")).toBe(false);
    expect(agentUsesHeuristics(undefined)).toBe(false);
  });
});

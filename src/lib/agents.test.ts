import { describe, expect, it } from "vitest";
import { detectAgent } from "./agents";

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

import { describe, it, expect, vi } from "vitest";

// logsClient defines invoke-backed commands at module load, but the pure formatter doesn't call
// invoke — stub the tauri core so the import resolves in the test env.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { logToMarkdown } from "./logsClient";

describe("logToMarkdown (§3b transcript export)", () => {
  it("wraps a transcript in a titled, fenced markdown block with a size line", () => {
    const md = logToMarkdown({ name: "Home-Faye", size: 2048 }, "hello\nworld");
    expect(md).toContain("# Session transcript — Home-Faye");
    expect(md).toContain("2.0 KB");
    expect(md).toContain("```text\nhello\nworld\n```");
  });

  it("shows bytes for a small log", () => {
    expect(logToMarkdown({ name: "x", size: 40 }, "hi")).toContain("40 B");
  });

  it("neutralizes embedded ``` fences so they can't break out of the block", () => {
    const md = logToMarkdown({ name: "x", size: 10 }, "before ``` after");
    expect(md).not.toContain("before ``` after");
    expect(md).toContain("ʼʼʼ");
  });
});

import { describe, expect, it } from "vitest";
import { isPaneStuck } from "./idle";

const NOW = 1_000_000;
const THRESH = 45_000; // 45s

describe("isPaneStuck", () => {
  const agent = { runningAgent: true, lastOutputAt: NOW };

  it("flags a running agent that's been silent past the threshold", () => {
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 46_000 }, NOW, THRESH)).toBe(true);
  });

  it("does not flag while output is recent", () => {
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 5_000 }, NOW, THRESH)).toBe(false);
  });

  it("flags exactly at the threshold boundary", () => {
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 45_000 }, NOW, THRESH)).toBe(true);
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 44_999 }, NOW, THRESH)).toBe(false);
  });

  it("never flags a non-agent / exited pane (a long shell command isn't 'stuck')", () => {
    expect(isPaneStuck({ runningAgent: false, lastOutputAt: NOW - 60_000 }, NOW, THRESH)).toBe(false);
  });

  it("does not flag before any output has been seen (no baseline)", () => {
    expect(isPaneStuck({ runningAgent: true, lastOutputAt: 0 }, NOW, THRESH)).toBe(false);
  });

  it("is disabled when the threshold is 0 or negative", () => {
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 999_999 }, NOW, 0)).toBe(false);
    expect(isPaneStuck({ ...agent, lastOutputAt: NOW - 999_999 }, NOW, -1)).toBe(false);
  });
});

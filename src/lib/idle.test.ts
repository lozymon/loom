import { describe, expect, it } from "vitest";
import { isPaneStuck } from "./idle";

const NOW = 1_000_000;
const THRESH = 45_000; // 45s

describe("isPaneStuck", () => {
  const agentBusy = { busy: true, isAgent: true, lastOutputAt: NOW };

  it("flags a busy agent that's been silent past the threshold", () => {
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 46_000 }, NOW, THRESH)).toBe(true);
  });

  it("does not flag while output is recent", () => {
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 5_000 }, NOW, THRESH)).toBe(false);
  });

  it("flags exactly at the threshold boundary", () => {
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 45_000 }, NOW, THRESH)).toBe(true);
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 44_999 }, NOW, THRESH)).toBe(false);
  });

  it("never flags a non-agent pane (a long shell command isn't 'stuck')", () => {
    expect(isPaneStuck({ busy: true, isAgent: false, lastOutputAt: NOW - 60_000 }, NOW, THRESH)).toBe(false);
  });

  it("never flags an idle pane (at the shell prompt, not busy)", () => {
    expect(isPaneStuck({ busy: false, isAgent: true, lastOutputAt: NOW - 60_000 }, NOW, THRESH)).toBe(false);
    expect(isPaneStuck({ busy: null, isAgent: true, lastOutputAt: NOW - 60_000 }, NOW, THRESH)).toBe(false);
  });

  it("does not flag before any output has been seen (no baseline)", () => {
    expect(isPaneStuck({ busy: true, isAgent: true, lastOutputAt: 0 }, NOW, THRESH)).toBe(false);
  });

  it("is disabled when the threshold is 0 or negative", () => {
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 999_999 }, NOW, 0)).toBe(false);
    expect(isPaneStuck({ ...agentBusy, lastOutputAt: NOW - 999_999 }, NOW, -1)).toBe(false);
  });
});

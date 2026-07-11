import { describe, expect, it } from "vitest";
import {
  appendTail,
  lastLine,
  promptShaped,
  looksWaiting,
  TAIL_CAP,
  HEURISTIC_DWELL_MS,
  type WaitingInputs,
} from "./outputObserver";

describe("appendTail", () => {
  it("concatenates chunks", () => {
    expect(appendTail("foo", "bar")).toBe("foobar");
    expect(appendTail("", "hi")).toBe("hi");
  });

  it("caps the tail from the end (keeps the most recent bytes)", () => {
    const prev = "x".repeat(TAIL_CAP);
    const out = appendTail(prev, "PROMPT", TAIL_CAP);
    expect(out.length).toBe(TAIL_CAP);
    expect(out.endsWith("PROMPT")).toBe(true);
    expect(out.startsWith("x")).toBe(true);
  });

  it("keeps a prompt whole when it straddles a chunk boundary (concat-then-trim)", () => {
    // Split "Continue? (y/n)" across two feeds — the last line must reassemble intact.
    const a = appendTail("", "output line\nCont");
    const b = appendTail(a, "inue? (y/n) ");
    expect(lastLine(b)).toBe("Continue? (y/n)");
    expect(promptShaped(b)).toBe(true);
  });
});

describe("lastLine", () => {
  it("returns the last non-blank line, ANSI-stripped and right-trimmed", () => {
    expect(lastLine("first\nsecond   ")).toBe("second");
    expect(lastLine("prompt?\n\n  \n")).toBe("prompt?"); // trailing blank lines skipped
    expect(lastLine("\x1b[32mAllow?\x1b[0m ")).toBe("Allow?"); // ANSI colour stripped
  });

  it("survives an ANSI escape split across chunks (stripped after concat)", () => {
    // ESC split: "\x1b" then "[31mProceed?\x1b[0m" — stripAnsi runs on the joined tail.
    const t = appendTail(appendTail("", "\x1b"), "[31mProceed?\x1b[0m");
    expect(lastLine(t)).toBe("Proceed?");
  });

  it("is empty for blank / whitespace-only tails", () => {
    expect(lastLine("")).toBe("");
    expect(lastLine("   \n\t\n")).toBe("");
  });
});

describe("promptShaped", () => {
  it("flags prompt-shaped last lines", () => {
    for (const t of [
      "Do you want to continue?",
      "Overwrite build/ (y/n)",
      "Apply this change? [Y/n]",
      "Press Enter to continue",
      "Proceed?",
      "Would you like to install it",
      "run `rm -rf build`? ",
      "aider> ", // ends with '>' … actually not in the conservative set — see negatives
      "❯ ",
    ]) {
      // '>' bare is intentionally NOT a prompt shape; assert the real ones below individually.
      void t;
    }
    expect(promptShaped("Do you want to continue?")).toBe(true);
    expect(promptShaped("Overwrite build/ (y/n)")).toBe(true);
    expect(promptShaped("Apply this change? [Y/n]")).toBe(true);
    expect(promptShaped("Press Enter to continue")).toBe(true);
    expect(promptShaped("Proceed?")).toBe(true);
    expect(promptShaped("Would you like to install it")).toBe(true);
    expect(promptShaped("run `rm -rf build`? ")).toBe(true);
    expect(promptShaped("❯ ")).toBe(true);
  });

  it("does not flag ordinary output (conservative — false negatives are free)", () => {
    expect(promptShaped("Building project…")).toBe(false);
    expect(promptShaped("Wrote 3 files")).toBe(false);
    expect(promptShaped("const x = 1;")).toBe(false);
    expect(promptShaped("https://example.com")).toBe(false); // ends with 'm', not a prompt
    expect(promptShaped("Enter value:")).toBe(false); // bare trailing colon is too broad → excluded
    expect(promptShaped("")).toBe(false);
  });

  it("reads the LAST line, so output after a prompt clears the shape", () => {
    expect(promptShaped("Continue?\nRunning tests…")).toBe(false);
  });
});

describe("looksWaiting", () => {
  const base: WaitingInputs = {
    runningAgent: true,
    promptShaped: true,
    idleMs: HEURISTIC_DWELL_MS + 1,
    thresholdMs: HEURISTIC_DWELL_MS,
    hasPushedSignal: false,
  };

  it("fires for an opt-in agent that printed a prompt then went quiet", () => {
    expect(looksWaiting(base)).toBe(true);
  });

  it("requires a running opt-in agent", () => {
    expect(looksWaiting({ ...base, runningAgent: false })).toBe(false);
  });

  it("requires the content signal", () => {
    expect(looksWaiting({ ...base, promptShaped: false })).toBe(false);
  });

  it("waits out the dwell so a still-streaming prompt isn't flagged", () => {
    expect(looksWaiting({ ...base, idleMs: HEURISTIC_DWELL_MS - 1 })).toBe(false);
    expect(looksWaiting({ ...base, idleMs: 0 })).toBe(false);
  });

  it("yields to a pushed/rich fact (rule 3 — pushed beats scraped)", () => {
    expect(looksWaiting({ ...base, hasPushedSignal: true })).toBe(false);
  });

  it("does NOT gate on kernel busy — a prompt-blocked agent is still the foreground process", () => {
    // Regression guard: gating on busy would suppress the guess exactly when it's needed (the §1b
    // trap idle.ts documents). The dwell, not busy, separates working from waiting.
    expect(looksWaiting({ ...base })).toBe(true);
  });

  it("thresholdMs <= 0 disables the dwell gate", () => {
    expect(looksWaiting({ ...base, idleMs: 0, thresholdMs: 0 })).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearances,
  requestClearance,
  resolveClearance,
  withdrawClearance,
  listClearances,
  pendingClearanceCount,
  resetClearances,
} from "./clearances";

// Clearances are the state behind the de-blocked guardrails (ADR-0012 rule 3.4): a bus command
// parked pending a human go/no-go, replacing the synchronous `window.confirm` that froze the
// webview. Tests pin the settle semantics directly — the guardrail wiring lives in
// paneControl.test.ts, and the caller-liveness half is control.rs's.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  resetClearances();
  vi.useRealTimers();
});

describe("clearances", () => {
  it("parks a command and exposes it while pending", async () => {
    const p = requestClearance({ kind: "spawn", summary: "A pane wants to run:", detail: "npm run build" });
    expect(pendingClearanceCount()).toBe(1);
    expect(listClearances()[0]).toMatchObject({
      id: 1,
      kind: "spawn",
      summary: "A pane wants to run:",
      detail: "npm run build",
      targets: [],
      at: 1000,
      expiresAt: null,
    });
    resolveClearance(1, true);
    await expect(p).resolves.toBe("approved");
  });

  it("resolves approved / denied on an operator decision, and clears the entry", async () => {
    const ok = requestClearance({ kind: "spawn", summary: "s" });
    resolveClearance(1, true);
    await expect(ok).resolves.toBe("approved");
    expect(clearances[1]).toBeUndefined();

    const no = requestClearance({ kind: "spawn", summary: "s" });
    resolveClearance(2, false);
    await expect(no).resolves.toBe("denied");
    expect(clearances[2]).toBeUndefined();
  });

  it("withdraw is NOT a denial — the caller left, so nobody decided", async () => {
    // The distinction is the point: `denied` is an operator choice and gets audited as one;
    // `withdrawn` must not, or the audit trail fills with decisions that never happened.
    const p = requestClearance({ kind: "spawn", summary: "s" });
    expect(withdrawClearance(1)).toBe(true);
    await expect(p).resolves.toBe("withdrawn");
    expect(clearances[1]).toBeUndefined();
  });

  it("settles exactly once — a late or duplicate answer is a no-op", async () => {
    const p = requestClearance({ kind: "spawn", summary: "s" });
    expect(resolveClearance(1, true)).toBe(true);
    // The caller's socket dies just after the operator approved: the abort must not re-settle.
    expect(withdrawClearance(1)).toBe(false);
    expect(resolveClearance(1, false)).toBe(false);
    await expect(p).resolves.toBe("approved");
  });

  it("a withdrawn Clearance can never be approved afterwards", async () => {
    // The invariant that keeps the old zombie-spawn dead: once the caller is gone, Approve is
    // unreachable — dispatch must not execute a command nobody awaits.
    const p = requestClearance({ kind: "spawn", summary: "s" });
    withdrawClearance(1);
    expect(resolveClearance(1, true)).toBe(false);
    await expect(p).resolves.toBe("withdrawn");
  });

  it("default-denies at the ttl deadline (Flow A), and reports expiresAt", async () => {
    const p = requestClearance({ kind: "spawn", summary: "s", ttlMs: 60_000 });
    expect(clearances[1].expiresAt).toBe(61_000);
    vi.advanceTimersByTime(59_999);
    expect(pendingClearanceCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toBe("expired");
    expect(clearances[1]).toBeUndefined();
  });

  it("no ttl means no wall clock — a local Clearance waits on its caller, not a timer", async () => {
    const p = requestClearance({ kind: "gated-input", summary: "s" });
    expect(clearances[1].expiresAt).toBeNull();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(pendingClearanceCount()).toBe(1);
    withdrawClearance(1);
    await expect(p).resolves.toBe("withdrawn");
  });

  it("an early decision cancels the ttl timer (no late expire)", async () => {
    const p = requestClearance({ kind: "spawn", summary: "s", ttlMs: 60_000 });
    resolveClearance(1, true);
    await expect(p).resolves.toBe("approved");
    vi.advanceTimersByTime(120_000); // the timer must be gone, not re-settling a dead id
    expect(pendingClearanceCount()).toBe(0);
  });

  it("carries the panes a command would touch", () => {
    requestClearance({ kind: "gated-input", summary: "s", detail: "y", targets: [3, 7] });
    expect(clearances[1].targets).toEqual([3, 7]);
  });

  it("lists oldest-first and tracks several at once", () => {
    requestClearance({ kind: "spawn", summary: "first" });
    vi.setSystemTime(2000);
    requestClearance({ kind: "destructive-broadcast", summary: "second" });
    expect(pendingClearanceCount()).toBe(2);
    expect(listClearances().map((c) => c.summary)).toEqual(["first", "second"]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { holds, gatePane, releaseGate, isGated, getGate, listGates, forgetGate } from "./inputHolds";

// The input-holds store is the state behind `loom gate`/`gate_pane` (§4a): a per-pane, ephemeral
// gate on inbound bus input, keyed by PaneId. Tests pin the gate semantics directly; the bus
// routing + confirm-on-delivery enforcement lives in paneControl.test.ts.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
  for (const id of Object.keys(holds)) forgetGate(Number(id));
});

describe("inputHolds", () => {
  it("gates a pane for the caller with a timestamp", () => {
    expect(gatePane(1, "op")).toEqual({ fresh: true });
    expect(holds[1]).toEqual({ by: "op", at: 1000, reason: undefined });
    expect(isGated(1)).toBe(true);
  });

  it("carries an optional reason", () => {
    gatePane(1, "op", "touches prod");
    expect(getGate(1)).toEqual({ by: "op", at: 1000, reason: "touches prod" });
  });

  it("re-gating is idempotent (fresh=false, timestamp kept) but can refresh the reason", () => {
    gatePane(1, "op", "first");
    vi.setSystemTime(2000);
    expect(gatePane(1, "someone-else", "second")).toEqual({ fresh: false });
    expect(holds[1].at).toBe(1000); // original time + holder kept
    expect(holds[1].by).toBe("op");
    expect(holds[1].reason).toBe("second"); // reason refreshed
  });

  it("isGated is false for an ungated pane", () => {
    expect(isGated(99)).toBe(false);
    expect(getGate(99)).toBeUndefined();
  });

  it("releaseGate drops the gate and reports whether one existed", () => {
    gatePane(1, "op");
    expect(releaseGate(1)).toBe(true);
    expect(isGated(1)).toBe(false);
    expect(releaseGate(1)).toBe(false); // nothing to drop now
  });

  it("lists gated panes oldest-first", () => {
    gatePane(2, "op");
    vi.setSystemTime(1500);
    gatePane(1, "op", "why");
    expect(listGates()).toEqual([
      { paneId: 2, by: "op", at: 1000, reason: undefined },
      { paneId: 1, by: "op", at: 1500, reason: "why" },
    ]);
  });

  it("forgetGate removes a pane's gate (called on pane close)", () => {
    gatePane(1, "op");
    forgetGate(1);
    expect(isGated(1)).toBe(false);
    expect(listGates()).toEqual([]);
  });
});

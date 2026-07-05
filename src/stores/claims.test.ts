import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { claims, claimFile, releaseFile, listClaims, forgetClaims } from "./claims";

// The claims store is the pure test-and-set behind `loom claim/release/claims` (§2c). Tests pin
// the lock semantics directly; the bus routing onto these calls lives in paneControl.test.ts.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
  for (const wsId of Object.keys(claims)) forgetClaims(wsId);
});

describe("claims", () => {
  it("claims a free path for the caller", () => {
    expect(claimFile("w1", "a.ts", "Faye")).toEqual({ ok: true, fresh: true });
    expect(claims.w1["a.ts"]).toEqual({ by: "Faye", at: 1000 });
  });

  it("re-claiming your own path is idempotent (fresh=false, timestamp kept)", () => {
    claimFile("w1", "a.ts", "Faye");
    vi.setSystemTime(2000);
    expect(claimFile("w1", "a.ts", "Faye")).toEqual({ ok: true, fresh: false });
    expect(claims.w1["a.ts"].at).toBe(1000); // original time, not re-stamped
  });

  it("claiming a path held by another fails with the holder", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(claimFile("w1", "a.ts", "Cleo")).toEqual({ ok: false, by: "Faye", at: 1000 });
    expect(claims.w1["a.ts"].by).toBe("Faye"); // unchanged
  });

  it("claims are scoped per workspace", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(claimFile("w2", "a.ts", "Cleo")).toEqual({ ok: true, fresh: true });
  });

  it("the holder can release; then the path is free again", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(releaseFile("w1", "a.ts", "Faye")).toEqual({ ok: true });
    expect(claims.w1?.["a.ts"]).toBeUndefined();
    expect(claimFile("w1", "a.ts", "Cleo")).toEqual({ ok: true, fresh: true });
  });

  it("releasing an unheld path reports unheld", () => {
    expect(releaseFile("w1", "a.ts", "Faye")).toEqual({ ok: false, reason: "unheld" });
  });

  it("a non-holder cannot release without force", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(releaseFile("w1", "a.ts", "Cleo")).toEqual({ ok: false, reason: "other", by: "Faye" });
    expect(claims.w1["a.ts"].by).toBe("Faye"); // still held
  });

  it("force lets a coordinator clear another pane's lock", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(releaseFile("w1", "a.ts", "Cleo", true)).toEqual({ ok: true });
    expect(claims.w1?.["a.ts"]).toBeUndefined();
  });

  it("lists claims path-sorted, per workspace", () => {
    claimFile("w1", "b.ts", "Faye");
    claimFile("w1", "a.ts", "Cleo");
    claimFile("w2", "z.ts", "Iris");
    expect(listClaims("w1")).toEqual([
      { path: "a.ts", by: "Cleo", at: 1000 },
      { path: "b.ts", by: "Faye", at: 1000 },
    ]);
    expect(listClaims("empty")).toEqual([]);
  });

  it("forgetClaims drops a workspace's locks", () => {
    claimFile("w1", "a.ts", "Faye");
    forgetClaims("w1");
    expect(listClaims("w1")).toEqual([]);
  });
});

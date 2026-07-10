import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { claims, claimFile, holdClaim, releaseFile, listClaims, releaseClaimsBy, forgetClaims } from "./claims";

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

  it("holds (gates) a path so a later claim blocks (§3)", () => {
    expect(holdClaim("w1", "a.ts", "op")).toEqual({ ok: true, fresh: true });
    expect(claims.w1["a.ts"]).toEqual({ by: "op", at: 1000, held: true });
    // an agent's claim on the held path is refused as gated
    expect(claimFile("w1", "a.ts", "Faye")).toEqual({ ok: false, held: true, by: "op" });
  });

  it("release clears a gate, then the path can be claimed", () => {
    holdClaim("w1", "a.ts", "op");
    expect(releaseFile("w1", "a.ts", "op")).toEqual({ ok: true });
    expect(claimFile("w1", "a.ts", "Faye")).toEqual({ ok: true, fresh: true });
  });

  it("holding an existing claim flips it to held (idempotent)", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(holdClaim("w1", "a.ts", "op")).toEqual({ ok: true, fresh: true });
    expect(claims.w1["a.ts"]).toMatchObject({ by: "Faye", held: true });
    expect(holdClaim("w1", "a.ts", "op")).toEqual({ ok: true, fresh: false }); // already held
    expect(listClaims("w1")).toEqual([{ path: "a.ts", by: "Faye", at: 1000, held: true }]);
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

  it("releaseClaimsBy frees only the dead pane's locks, leaving others", () => {
    claimFile("w1", "a.ts", "Faye");
    claimFile("w1", "b.ts", "Faye");
    claimFile("w1", "c.ts", "Cleo");
    claimFile("w2", "d.ts", "Faye"); // other workspace — untouched
    expect(releaseClaimsBy("w1", "Faye")).toBe(2);
    expect(listClaims("w1")).toEqual([{ path: "c.ts", by: "Cleo", at: 1000 }]);
    expect(listClaims("w2")).toEqual([{ path: "d.ts", by: "Faye", at: 1000 }]);
    // the freed path can be re-taken by anyone
    expect(claimFile("w1", "a.ts", "Cleo")).toEqual({ ok: true, fresh: true });
  });

  it("releaseClaimsBy is a no-op (0) for a pane holding nothing", () => {
    claimFile("w1", "a.ts", "Faye");
    expect(releaseClaimsBy("w1", "Wade")).toBe(0);
    expect(releaseClaimsBy("empty", "Faye")).toBe(0);
    expect(listClaims("w1")).toHaveLength(1);
  });
});

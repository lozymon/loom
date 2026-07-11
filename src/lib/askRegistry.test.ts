import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAsk, awaitAsk, replyAsk, cancelAsk, openAskCount, listOpenAsks, subscribeAsks } from "./askRegistry";

// The correlation registry behind `loom ask` / `loom reply` (§2a). The mailbox semantics — parked
// long-polls resolving on a reply, stashing a reply that beats the next poll, expiry, cancel — are
// the whole point, so they're pinned directly here (the bus routing lives in paneControl.test.ts).
// Time is faked so poll/expiry windows are controllable; assertions use openAskCount deltas so a
// stray entry from one test can't corrupt another.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("askRegistry", () => {
  it("awaiting an unknown id resolves unknown", async () => {
    await expect(awaitAsk(9999, 8000)).resolves.toEqual({ state: "unknown" });
  });

  it("a reply resolves a parked poll with the answer, then retires the entry", async () => {
    const before = openAskCount();
    const id = createAsk("Cleo", "Faye", "which auth lib?", 300_000);
    const poll = awaitAsk(id, 8000);
    expect(replyAsk(id, "lucia-auth", "Cleo")).toBe(true);
    await expect(poll).resolves.toEqual({ state: "answered", answer: "lucia-auth", by: "Cleo" });
    expect(openAskCount()).toBe(before); // consumed
  });

  it("a reply that beats the next poll is stashed and picked up by it", async () => {
    const before = openAskCount();
    const id = createAsk("Cleo", "Faye", "q", 300_000);
    // No poll parked yet — reply stashes the answer on the entry.
    expect(replyAsk(id, "stashed", "Cleo")).toBe(true);
    await expect(awaitAsk(id, 8000)).resolves.toEqual({ state: "answered", answer: "stashed", by: "Cleo" });
    expect(openAskCount()).toBe(before); // consumed by the await
  });

  it("a poll with no reply resolves pending after waitMs (ask stays open)", async () => {
    const before = openAskCount();
    const id = createAsk("Cleo", "Faye", "q", 300_000);
    const poll = awaitAsk(id, 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(poll).resolves.toEqual({ state: "pending" });
    expect(openAskCount()).toBe(before + 1); // still open for the next poll
    cancelAsk(id);
    expect(openAskCount()).toBe(before);
  });

  it("expiry fires before a longer poll and resolves it expired", async () => {
    const before = openAskCount();
    const id = createAsk("Cleo", "Faye", "q", 5000);
    const poll = awaitAsk(id, 8000);
    await vi.advanceTimersByTimeAsync(5000); // expiry (5s) beats the poll timeout (8s)
    await expect(poll).resolves.toEqual({ state: "expired" });
    expect(openAskCount()).toBe(before); // dropped
    await expect(awaitAsk(id, 8000)).resolves.toEqual({ state: "unknown" });
  });

  it("replying twice fails the second time (already answered)", async () => {
    const id = createAsk("Cleo", "Faye", "q", 300_000);
    expect(replyAsk(id, "first")).toBe(true);
    expect(replyAsk(id, "second")).toBe(false);
    cancelAsk(id);
  });

  it("replying to an unknown id fails", () => {
    expect(replyAsk(123456, "x")).toBe(false);
  });

  it("cancel resolves a parked poll unknown and drops the entry", async () => {
    const before = openAskCount();
    const id = createAsk("Cleo", "Faye", "q", 300_000);
    const poll = awaitAsk(id, 8000);
    cancelAsk(id);
    await expect(poll).resolves.toEqual({ state: "unknown" });
    expect(openAskCount()).toBe(before);
  });

  it("hands out monotonically increasing ids", () => {
    const a = createAsk("Cleo", "Faye", "q", 300_000);
    const b = createAsk("Cleo", "Faye", "q", 300_000);
    expect(b).toBeGreaterThan(a);
    cancelAsk(a);
    cancelAsk(b);
  });

  // ---- Open-asks projection (§2a/§2e — the Fleet-panel list) ----

  it("listOpenAsks surfaces an open ask's fields and drops it once answered", () => {
    const id = createAsk("Cleo", "Faye", "which auth lib?", 300_000);
    const mine = listOpenAsks().find((a) => a.id === id);
    expect(mine).toMatchObject({ id, target: "Cleo", from: "Faye", question: "which auth lib?" });
    expect(typeof mine!.at).toBe("number");
    replyAsk(id, "lucia"); // answered → no longer "open"
    expect(listOpenAsks().some((a) => a.id === id)).toBe(false);
    cancelAsk(id); // retire the answered-but-unconsumed entry so it can't skew later counts
  });

  it("notifies subscribers with a fresh snapshot on create, and on reply/expire/cancel", () => {
    const seen: number[] = [];
    const unsub = subscribeAsks((open) => seen.push(open.length));
    const last = () => seen[seen.length - 1];

    const base = listOpenAsks().length;
    const id = createAsk("Cleo", "Faye", "q", 300_000);
    expect(last()).toBe(base + 1); // create emitted
    expect(listOpenAsks().some((a) => a.id === id)).toBe(true);

    cancelAsk(id);
    expect(last()).toBe(base); // cancel emitted, back to baseline

    unsub();
    const seenCount = seen.length;
    const id2 = createAsk("Cleo", "Faye", "q", 300_000);
    // No further notifications after unsubscribe.
    expect(seen.length).toBe(seenCount);
    cancelAsk(id2);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { board, noteSet, noteGet, noteList, noteDel, forgetBoard } from "./blackboard";

// The blackboard is the pure per-workspace key/value store behind `loom note` (§2b). These tests
// pin the store semantics directly (the routing that maps a bus request onto these calls is
// covered in paneControl.test.ts). Time is frozen so the `at` timestamp is assertable.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  vi.useRealTimers();
  // Leave no cross-test residue in the module-level store.
  for (const wsId of Object.keys(board)) forgetBoard(wsId);
});

describe("blackboard", () => {
  it("set then get round-trips value, writer and timestamp", () => {
    noteSet("w1", "plan.api", "Cleo — wip", "Faye");
    expect(noteGet("w1", "plan.api")).toEqual({ value: "Cleo — wip", by: "Faye", at: 1000 });
  });

  it("set overwrites and re-stamps the entry", () => {
    noteSet("w1", "k", "old", "Faye");
    vi.setSystemTime(2000);
    noteSet("w1", "k", "new", "Cleo");
    expect(noteGet("w1", "k")).toEqual({ value: "new", by: "Cleo", at: 2000 });
  });

  it("scopes keys per workspace — same key, different boards", () => {
    noteSet("w1", "owner", "Faye", "Faye");
    noteSet("w2", "owner", "Cleo", "Cleo");
    expect(noteGet("w1", "owner")?.value).toBe("Faye");
    expect(noteGet("w2", "owner")?.value).toBe("Cleo");
  });

  it("get is undefined for an unknown board or key", () => {
    expect(noteGet("nope", "k")).toBeUndefined();
    noteSet("w1", "a", "1", "Faye");
    expect(noteGet("w1", "b")).toBeUndefined();
  });

  it("list returns entries key-sorted, only for that workspace", () => {
    noteSet("w1", "b", "2", "Faye");
    noteSet("w1", "a", "1", "Cleo");
    noteSet("w2", "z", "9", "Iris");
    expect(noteList("w1")).toEqual([
      { key: "a", value: "1", by: "Cleo", at: 1000 },
      { key: "b", value: "2", by: "Faye", at: 1000 },
    ]);
    expect(noteList("empty")).toEqual([]);
  });

  it("del removes a key and reports whether it existed", () => {
    noteSet("w1", "a", "1", "Faye");
    expect(noteDel("w1", "a")).toBe(true);
    expect(noteGet("w1", "a")).toBeUndefined();
    expect(noteDel("w1", "a")).toBe(false);
    expect(noteDel("w1", "never")).toBe(false);
  });

  it("forgetBoard drops the whole workspace board", () => {
    noteSet("w1", "a", "1", "Faye");
    noteSet("w1", "b", "2", "Faye");
    forgetBoard("w1");
    expect(noteList("w1")).toEqual([]);
    expect(noteGet("w1", "a")).toBeUndefined();
  });
});

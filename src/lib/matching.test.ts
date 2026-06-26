import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./matching";

describe("fuzzyScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "New Workspace")).toBeNull();
    expect(fuzzyScore("wn", "New")).toBeNull(); // order matters
  });

  it("matches subsequences and scores an empty query as 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("nw", "New Workspace")).not.toBeNull();
  });

  it("ranks word-boundary / contiguous matches above scattered ones", () => {
    const boundary = fuzzyScore("nw", "New Workspace")!;
    const scattered = fuzzyScore("nw", "Antwerp")!;
    expect(boundary).toBeGreaterThan(scattered);

    const contiguous = fuzzyScore("clo", "Cloud")!;
    const split = fuzzyScore("clo", "Council of Owls")!;
    expect(contiguous).toBeGreaterThan(split);
  });
});

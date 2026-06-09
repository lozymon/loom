import { describe, expect, it } from "vitest";
import { fuzzyScore, globToRegExp, matchesPattern } from "./matching";

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

describe("globToRegExp", () => {
  it("expands * and ? and anchors the whole string", () => {
    expect(globToRegExp("Cl*").test("Cleo")).toBe(true);
    expect(globToRegExp("Cl*").test("Wade")).toBe(false);
    expect(globToRegExp("Pane ?").test("Pane 3")).toBe(true);
    expect(globToRegExp("Pane ?").test("Pane 30")).toBe(false);
  });

  it("is case-insensitive and escapes regex metachars", () => {
    expect(globToRegExp("a.b*").test("A.bcd")).toBe(true);
    expect(globToRegExp("a.b*").test("axbcd")).toBe(false); // the dot is literal
  });
});

describe("matchesPattern", () => {
  it("treats a plain pattern as a case-insensitive substring", () => {
    expect(matchesPattern("Cleo", "cl")).toBe(true);
    expect(matchesPattern("Wade", "cl")).toBe(false);
  });

  it("treats a wildcard pattern as a glob", () => {
    expect(matchesPattern("Cleo", "C*o")).toBe(true);
    expect(matchesPattern("Cleo", "C*x")).toBe(false);
  });

  it("matches everything on an empty pattern", () => {
    expect(matchesPattern("anything", "  ")).toBe(true);
  });
});

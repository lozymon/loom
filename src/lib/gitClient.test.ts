import { describe, expect, it } from "vitest";
import { formatDiffSelection, parseUnifiedDiff, type DiffRow } from "./gitClient";

const DIFF = [
  "diff --git a/f.txt b/f.txt",
  "index 0000000..1111111 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,4 @@",
  "+added top",
  " context one",
  "-removed",
  "+changed",
  " context two",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("skips file/index headers and emits a hunk band", () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(rows[0]).toEqual({ kind: "hunk", header: "@@ -1,3 +1,4 @@" });
  });

  it("emits a pure addition with no old-side line number", () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(rows[1]).toEqual({ kind: "line", sign: "+", oldNo: null, newNo: 1, text: "added top" });
  });

  it("tracks old/new line numbers across context and a replace", () => {
    const lines = parseUnifiedDiff(DIFF).filter(
      (r): r is Extract<DiffRow, { kind: "line" }> => r.kind === "line",
    );
    // lines: [+added, ctx, -removed, +changed, ctx]
    expect(lines[1]).toEqual({ kind: "line", sign: " ", oldNo: 1, newNo: 2, text: "context one" });
    expect(lines[2]).toEqual({ kind: "line", sign: "-", oldNo: 2, newNo: null, text: "removed" });
    expect(lines[3]).toEqual({ kind: "line", sign: "+", oldNo: null, newNo: 3, text: "changed" });
    expect(lines[4]).toEqual({ kind: "line", sign: " ", oldNo: 3, newNo: 4, text: "context two" });
  });

  it("ignores a \\ No newline marker", () => {
    const d = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    const lines = parseUnifiedDiff(d).filter((r) => r.kind === "line");
    expect(lines).toEqual([
      { kind: "line", sign: "-", oldNo: 1, newNo: null, text: "a" },
      { kind: "line", sign: "+", oldNo: null, newNo: 1, text: "b" },
    ]);
  });
});

describe("formatDiffSelection", () => {
  it("rebuilds unified text for a contiguous selection across context and a replace", () => {
    const rows = parseUnifiedDiff(DIFF);
    // indices 2,3,4 are context one / removed / changed (0 is the hunk band, 1 the +add)
    const sel = formatDiffSelection(rows, [2, 3, 4]);
    expect(sel.text).toBe([" context one", "-removed", "+changed"].join("\n"));
    expect(sel.count).toBe(3);
    expect(sel.start).toBe(2); // new-side number of "context one"
    expect(sel.end).toBe(3); // new-side number of "changed"
  });

  it("returns an empty selection when only a hunk band is chosen", () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(formatDiffSelection(rows, [0])).toMatchObject({ text: "", count: 0, start: 0, end: 0 });
  });
});

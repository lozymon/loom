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

  it("pairs a pure addition against an empty left cell", () => {
    const rows = parseUnifiedDiff(DIFF);
    const add = rows[1];
    expect(add).toMatchObject({
      kind: "pair",
      left: { kind: "empty", no: null },
      right: { kind: "add", no: 1, text: "added top" },
    });
  });

  it("tracks old/new line numbers across context and replace", () => {
    const rows = parseUnifiedDiff(DIFF).filter((r): r is Extract<DiffRow, { kind: "pair" }> => r.kind === "pair");
    // rows: [+added, ctx, -/+ replace, ctx]
    expect(rows[1]).toMatchObject({ left: { no: 1, kind: "ctx" }, right: { no: 2, kind: "ctx" } });
    expect(rows[2]).toMatchObject({ left: { no: 2, kind: "del" }, right: { no: 3, kind: "add" } });
    expect(rows[3]).toMatchObject({ left: { no: 3, kind: "ctx" }, right: { no: 4, kind: "ctx" } });
  });

  it("ignores a \\ No newline marker", () => {
    const d = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    const rows = parseUnifiedDiff(d).filter((r) => r.kind === "pair");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ left: { text: "a", kind: "del" }, right: { text: "b", kind: "add" } });
  });
});

describe("formatDiffSelection", () => {
  it("rebuilds unified text for a contiguous selection, emitting both sides of a replace", () => {
    const rows = parseUnifiedDiff(DIFF);
    // indices 2,3 are the context + replace rows (index 0 is the hunk band, 1 the +add)
    const sel = formatDiffSelection(rows, [2, 3]);
    expect(sel.text).toBe([" context one", "-removed", "+changed"].join("\n"));
    expect(sel.count).toBe(3);
    expect(sel.start).toBe(2);
    expect(sel.end).toBe(3);
  });

  it("returns an empty selection when no pair rows are chosen", () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(formatDiffSelection(rows, [0])).toMatchObject({ text: "", count: 0, start: 0, end: 0 });
  });
});

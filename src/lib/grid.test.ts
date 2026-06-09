import { describe, expect, it } from "vitest";
import { allocName, buildBalancedTree, NAME_POOL } from "./grid";
import type { LayoutNode } from "../ipc/protocol";

let seq = 0;
const leaf = (): LayoutNode => ({ kind: "leaf", paneId: ++seq });

function leafCount(node: LayoutNode): number {
  return node.kind === "leaf" ? 1 : leafCount(node.a) + leafCount(node.b);
}

/** Rows = top-level `col` bands; each band's width = its `row` leaves (width-biased grid). */
function shape(node: LayoutNode): number[] {
  const bands = node.kind === "split" && node.dir === "col" ? flatten(node, "col") : [node];
  return bands.map((b) => flatten(b, "row").length);
}
function flatten(node: LayoutNode, dir: "row" | "col"): LayoutNode[] {
  if (node.kind === "split" && node.dir === dir) return [...flatten(node.a, dir), ...flatten(node.b, dir)];
  return [node];
}

describe("buildBalancedTree", () => {
  it("produces exactly n leaves", () => {
    for (let n = 1; n <= 12; n++) {
      seq = 0;
      expect(leafCount(buildBalancedTree(n, leaf))).toBe(n);
    }
  });

  it("calls makeLeaf once per leaf", () => {
    let calls = 0;
    buildBalancedTree(6, () => { calls++; return leaf(); });
    expect(calls).toBe(6);
  });

  it("is width-biased: rows = floor(sqrt(n))", () => {
    seq = 0;
    expect(shape(buildBalancedTree(2, leaf))).toEqual([2]); // 1×2
    seq = 0;
    expect(shape(buildBalancedTree(4, leaf))).toEqual([2, 2]); // 2×2
    seq = 0;
    expect(shape(buildBalancedTree(6, leaf))).toEqual([3, 3]); // 2×3
    seq = 0;
    expect(shape(buildBalancedTree(12, leaf))).toEqual([4, 4, 4]); // 3×4
  });

  it("clamps non-positive counts to a single leaf", () => {
    expect(leafCount(buildBalancedTree(0, leaf))).toBe(1);
    expect(leafCount(buildBalancedTree(-3, leaf))).toBe(1);
  });
});

describe("allocName", () => {
  it("hands out distinct pool names in order", () => {
    expect(allocName([])).toBe(NAME_POOL[0]);
    expect(allocName([NAME_POOL[0]])).toBe(NAME_POOL[1]);
  });

  it("falls back to Pane N once the pool is exhausted", () => {
    expect(allocName(NAME_POOL)).toBe("Pane 1");
    expect(allocName([...NAME_POOL, "Pane 1"])).toBe("Pane 2");
  });

  it("reuses freed pool names", () => {
    const taken = NAME_POOL.filter((n) => n !== NAME_POOL[2]);
    expect(allocName(taken)).toBe(NAME_POOL[2]);
  });
});

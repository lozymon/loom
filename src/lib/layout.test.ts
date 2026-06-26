import { describe, expect, it } from "vitest";
import { computeLayout, firstLeaf, leafIds, neighbor, removeLeaf, replaceLeaf, swapLeaves } from "./layout";
import type { LayoutNode } from "../ipc/protocol";

const leaf = (paneId: number): LayoutNode => ({ kind: "leaf", paneId });

// A 2×2 grid: top band [1|2], bottom band [3|4], equal ratios.
const grid2x2: LayoutNode = {
  kind: "split", dir: "col", ratio: 0.5,
  a: { kind: "split", dir: "row", ratio: 0.5, a: leaf(1), b: leaf(2) },
  b: { kind: "split", dir: "row", ratio: 0.5, a: leaf(3), b: leaf(4) },
};

describe("computeLayout", () => {
  it("places a single leaf full-bleed", () => {
    const { leaves, gutters } = computeLayout(leaf(7));
    expect(gutters).toHaveLength(0);
    expect(leaves).toEqual([{ paneId: 7, rect: { x: 0, y: 0, w: 100, h: 100 } }]);
  });

  it("splits a 2×2 into four equal quadrants", () => {
    const { leaves, gutters } = computeLayout(grid2x2);
    const rect = (id: number) => leaves.find((l) => l.paneId === id)!.rect;
    expect(rect(1)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    expect(rect(2)).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(rect(3)).toEqual({ x: 0, y: 50, w: 50, h: 50 });
    expect(rect(4)).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    // One outer col gutter + two inner row gutters.
    expect(gutters).toHaveLength(3);
  });

  it("honours an asymmetric ratio", () => {
    const tree: LayoutNode = { kind: "split", dir: "row", ratio: 0.25, a: leaf(1), b: leaf(2) };
    const { leaves } = computeLayout(tree);
    expect(leaves.find((l) => l.paneId === 1)!.rect.w).toBe(25);
    expect(leaves.find((l) => l.paneId === 2)!.rect).toMatchObject({ x: 25, w: 75 });
  });
});

describe("neighbor (spatial focus nav)", () => {
  it("moves within the 2×2 grid", () => {
    expect(neighbor(grid2x2, 1, "right")).toBe(2);
    expect(neighbor(grid2x2, 1, "down")).toBe(3);
    expect(neighbor(grid2x2, 4, "left")).toBe(3);
    expect(neighbor(grid2x2, 4, "up")).toBe(2);
  });

  it("returns null past an edge", () => {
    expect(neighbor(grid2x2, 1, "left")).toBeNull();
    expect(neighbor(grid2x2, 1, "up")).toBeNull();
    expect(neighbor(grid2x2, 4, "right")).toBeNull();
    expect(neighbor(grid2x2, 4, "down")).toBeNull();
  });

  it("returns null for an unknown pane", () => {
    expect(neighbor(grid2x2, 99, "right")).toBeNull();
  });
});

describe("swapLeaves", () => {
  it("exchanges the positions of two leaves", () => {
    const swapped = swapLeaves(grid2x2, 1, 4);
    const { leaves } = computeLayout(swapped);
    const rect = (id: number) => leaves.find((l) => l.paneId === id)!.rect;
    // 1 now sits where 4 was (bottom-right) and vice versa.
    expect(rect(1)).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    expect(rect(4)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    // The other two are untouched.
    expect(rect(2)).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(rect(3)).toEqual({ x: 0, y: 50, w: 50, h: 50 });
  });

  it("is a no-op when an id is absent", () => {
    expect(swapLeaves(grid2x2, 1, 99)).toEqual(grid2x2);
  });

  it("preserves the total leaf set", () => {
    const ids = (n: LayoutNode): number[] =>
      n.kind === "leaf" ? [n.paneId] : [...ids(n.a), ...ids(n.b)];
    expect(ids(swapLeaves(grid2x2, 2, 3)).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("firstLeaf", () => {
  it("returns a lone leaf's id", () => {
    expect(firstLeaf(leaf(7))).toBe(7);
  });

  it("descends `a` first to the top-left leaf", () => {
    expect(firstLeaf(grid2x2)).toBe(1);
  });
});

describe("leafIds", () => {
  it("returns a single id for a leaf", () => {
    expect(leafIds(leaf(7))).toEqual([7]);
  });

  it("lists ids in row-major (a-before-b, depth-first) order", () => {
    expect(leafIds(grid2x2)).toEqual([1, 2, 3, 4]);
  });
});

describe("replaceLeaf", () => {
  it("splits the targeted leaf, keeping it as child `a` and a new pane as `b`", () => {
    const out = replaceLeaf(grid2x2, 2, (old) => ({
      kind: "split", dir: "row", ratio: 0.5, a: old, b: leaf(9),
    }));
    // 2 is now nested under a split alongside the new leaf 9; the rest is unchanged order.
    expect(leafIds(out)).toEqual([1, 2, 9, 3, 4]);
  });

  it("returns an equal tree when the id is absent", () => {
    expect(replaceLeaf(grid2x2, 99, () => leaf(0))).toEqual(grid2x2);
  });

  it("does not mutate the input tree", () => {
    const before = JSON.stringify(grid2x2);
    replaceLeaf(grid2x2, 1, () => leaf(42));
    expect(JSON.stringify(grid2x2)).toBe(before);
  });
});

describe("removeLeaf", () => {
  it("promotes the sibling when a leaf's parent split collapses", () => {
    // Drop 2 → its row-split parent collapses, leaving 1 alone in the top band.
    const out = removeLeaf(grid2x2, 2)!;
    expect(leafIds(out)).toEqual([1, 3, 4]);
    // The top band is now just leaf 1 (the surviving sibling promoted in place).
    expect((out as { kind: "split"; a: LayoutNode }).a).toEqual(leaf(1));
  });

  it("returns null when removing the only remaining leaf", () => {
    expect(removeLeaf(leaf(1), 1)).toBeNull();
  });

  it("returns an equal tree when the id is absent", () => {
    expect(removeLeaf(grid2x2, 99)).toEqual(grid2x2);
  });

  it("does not mutate the input tree", () => {
    const before = JSON.stringify(grid2x2);
    removeLeaf(grid2x2, 3);
    expect(JSON.stringify(grid2x2)).toBe(before);
  });
});

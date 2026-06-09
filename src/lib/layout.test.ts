import { describe, expect, it } from "vitest";
import { computeLayout, neighbor, swapLeaves } from "./layout";
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

// Pure geometry: flatten a LayoutNode tree into absolutely-positioned leaf boxes and the
// draggable gutters between splits. Rendering from this (rather than a recursive flex
// tree) lets every pane live in one flat, PaneId-keyed layer — so splitting/closing never
// remounts a leaf's <Terminal> and its PTY survives. All coordinates are percentages.

import type { LayoutNode, PaneId } from "../ipc/protocol";

/** A box in container-percentage units (0–100). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Path from the tree root to a node: a sequence of `a`/`b` child steps. */
export type Path = ("a" | "b")[];

export interface LeafBox {
  paneId: PaneId;
  rect: Rect;
}

export interface GutterBox {
  /** Path to the owning split node (so a drag can address it in the store). */
  path: Path;
  dir: "row" | "col";
  /** Seam coordinate in %: `x` for a `row` split, `y` for a `col` split. */
  pos: number;
  /** The split's own box — the drag converts a pointer position within it to a ratio. */
  splitRect: Rect;
}

export interface Layout {
  leaves: LeafBox[];
  gutters: GutterBox[];
}

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

/** Flatten `tree` into positioned leaves + gutters. */
export function computeLayout(tree: LayoutNode): Layout {
  const leaves: LeafBox[] = [];
  const gutters: GutterBox[] = [];

  const walk = (node: LayoutNode, rect: Rect, path: Path) => {
    if (node.kind === "leaf") {
      leaves.push({ paneId: node.paneId, rect });
      return;
    }
    if (node.dir === "row") {
      const aw = rect.w * node.ratio;
      gutters.push({ path, dir: "row", pos: rect.x + aw, splitRect: rect });
      walk(node.a, { x: rect.x, y: rect.y, w: aw, h: rect.h }, [...path, "a"]);
      walk(node.b, { x: rect.x + aw, y: rect.y, w: rect.w - aw, h: rect.h }, [...path, "b"]);
    } else {
      const ah = rect.h * node.ratio;
      gutters.push({ path, dir: "col", pos: rect.y + ah, splitRect: rect });
      walk(node.a, { x: rect.x, y: rect.y, w: rect.w, h: ah }, [...path, "a"]);
      walk(node.b, { x: rect.x, y: rect.y + ah, w: rect.w, h: rect.h - ah }, [...path, "b"]);
    }
  };

  walk(tree, FULL, []);
  return { leaves, gutters };
}

function hasLeaf(node: LayoutNode, id: PaneId): boolean {
  return node.kind === "leaf" ? node.paneId === id : hasLeaf(node.a, id) || hasLeaf(node.b, id);
}

/**
 * Return a copy of `tree` with the positions of leaves `a` and `b` exchanged (each keeps its
 * PaneId, so its <Terminal>/PTY survives — only where it sits in the grid changes). A no-op
 * unless *both* ids are present (and distinct). Pure: callers pass the result to the store.
 * Drives pane drag-to-swap.
 */
export function swapLeaves(node: LayoutNode, a: PaneId, b: PaneId): LayoutNode {
  if (a === b || !hasLeaf(node, a) || !hasLeaf(node, b)) return node;
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf") {
      if (n.paneId === a) return { kind: "leaf", paneId: b };
      if (n.paneId === b) return { kind: "leaf", paneId: a };
      return n;
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return walk(node);
}

export type Dir = "left" | "right" | "up" | "down";

/**
 * The PaneId spatially adjacent to `from` in `dir`, or null if none. Picks the nearest
 * leaf on the far side whose perpendicular span overlaps `from`'s; falls back to the
 * nearest by perpendicular-centre distance when nothing overlaps. Drives Ctrl+Shift+arrows.
 */
export function neighbor(tree: LayoutNode, from: PaneId, dir: Dir): PaneId | null {
  const { leaves } = computeLayout(tree);
  const me = leaves.find((l) => l.paneId === from);
  if (!me) return null;
  const r = me.rect;
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;

  // Near edge of `from` along the axis of travel, and its perpendicular centre.
  const myEdge = horizontal ? (sign > 0 ? r.x + r.w : r.x) : (sign > 0 ? r.y + r.h : r.y);
  const myPerpC = horizontal ? r.y + r.h / 2 : r.x + r.w / 2;

  let best: { id: PaneId; along: number; perp: number; overlap: boolean } | null = null;
  for (const l of leaves) {
    if (l.paneId === from) continue;
    const o = l.rect;
    const oNear = horizontal ? (sign > 0 ? o.x : o.x + o.w) : (sign > 0 ? o.y : o.y + o.h);
    const along = (oNear - myEdge) * sign; // >0 ⇒ on the far side along the axis
    if (along < -0.5) continue; // behind us
    // Perpendicular overlap between the two boxes.
    const [aLo, aHi] = horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w];
    const [bLo, bHi] = horizontal ? [o.y, o.y + o.h] : [o.x, o.x + o.w];
    const overlap = Math.min(aHi, bHi) - Math.max(aLo, bLo) > 0.5;
    const perpC = horizontal ? o.y + o.h / 2 : o.x + o.w / 2;
    const perp = Math.abs(perpC - myPerpC);
    const cand = { id: l.paneId, along: Math.max(0, along), perp, overlap };
    if (!best) { best = cand; continue; }
    // Prefer overlapping candidates; then nearest along the axis; then nearest perpendicular.
    if (cand.overlap !== best.overlap) { if (cand.overlap) best = cand; continue; }
    if (cand.along !== best.along) { if (cand.along < best.along) best = cand; continue; }
    if (cand.perp < best.perp) best = cand;
  }
  return best ? best.id : null;
}

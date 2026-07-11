// Regression coverage for the layout-tree store writes. The bug these guard against: Solid's
// store setter *merges* an object value key-by-key, so writing a shape-changed tree node with a
// bare `setApp(..., "tree", next)` left stale keys behind. Closing a workspace down to one pane
// collapsed the root split into a `kind:"leaf"` node that still carried `a`/`b`/`dir`/`ratio`;
// the next split then built on that corrupt node and silently did nothing — "close all panes
// except one and you can't open another". `setTree` (reconcile + clone) is the fix.

import { describe, it, expect, beforeEach } from "vitest";
import { unwrap } from "solid-js/store";
import { createRoot } from "solid-js";
import { computeLayout } from "../lib/layout";
import { activeWorkspace, createWorkspace, splitPane, closePane, switchWorkspace } from "./workspace";
import type { LayoutNode } from "../ipc/protocol";

/** Leaf pane-ids of the active workspace, in layout order (reads the real store tree). */
function leaves(): number[] {
  return computeLayout(unwrap(activeWorkspace()!.tree)).leaves.map((l) => l.paneId);
}

/** Every own key present on a node — used to assert no stale keys linger after a shape change. */
function keysOf(node: LayoutNode): string[] {
  return Object.keys(unwrap(node) as object).sort();
}

/** Assert the whole tree is well-formed: leaves carry exactly {kind,paneId}; splits exactly
 *  {kind,dir,ratio,a,b}. A merged/corrupt node (e.g. a leaf still holding `a`/`b`) fails here. */
function assertClean(node: LayoutNode) {
  if (node.kind === "leaf") {
    expect(keysOf(node)).toEqual(["kind", "paneId"]);
  } else {
    expect(keysOf(node)).toEqual(["a", "b", "dir", "kind", "ratio"]);
    assertClean(node.a);
    assertClean(node.b);
  }
}

describe("workspace store: layout-tree writes stay clean across close/split", () => {
  beforeEach(() => {
    // Start each test from a fresh, isolated workspace (the store is a module singleton).
    createRoot(() => {
      const id = createWorkspace({ name: `t-${Math.random()}`, cwd: "", paneCount: 4 });
      switchWorkspace(id);
    });
  });

  it("closing down to one pane leaves a clean leaf root (no stale split keys)", () => {
    createRoot(() => {
      const ids = leaves();
      expect(ids).toHaveLength(4);
      // Close every pane but the first.
      for (const id of ids.slice(1)) closePane(id, { skipConfirm: true });
      expect(leaves()).toEqual([ids[0]]);
      const root = unwrap(activeWorkspace()!.tree);
      expect(root.kind).toBe("leaf");
      assertClean(root); // would fail if `a`/`b`/`dir`/`ratio` lingered from the collapsed split
    });
  });

  it("can split again after collapsing to a single pane (the reported bug)", () => {
    createRoot(() => {
      const ids = leaves();
      for (const id of ids.slice(1)) closePane(id, { skipConfirm: true });
      const lone = leaves()[0];

      splitPane(lone, "row");
      const after = leaves();
      expect(after).toHaveLength(2); // a brand-new pane actually appeared
      expect(after[0]).toBe(lone); // the original survived
      assertClean(unwrap(activeWorkspace()!.tree));
    });
  });

  it("survives repeated collapse→split cycles without corrupting the tree", () => {
    createRoot(() => {
      for (let cycle = 0; cycle < 3; cycle++) {
        // Collapse to one.
        let ids = leaves();
        for (const id of ids.slice(1)) closePane(id, { skipConfirm: true });
        expect(leaves()).toHaveLength(1);
        // Grow back to three.
        splitPane(leaves()[0], "row");
        splitPane(leaves()[0], "col");
        expect(leaves()).toHaveLength(3);
        assertClean(unwrap(activeWorkspace()!.tree));
      }
    });
  });
});

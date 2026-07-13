// Regression coverage for the layout-tree store writes. The bug these guard against: Solid's
// store setter *merges* an object value key-by-key, so writing a shape-changed tree node with a
// bare `setApp(..., "tree", next)` left stale keys behind. Closing a workspace down to one pane
// collapsed the root split into a `kind:"leaf"` node that still carried `a`/`b`/`dir`/`ratio`;
// the next split then built on that corrupt node and silently did nothing — "close all panes
// except one and you can't open another". `setTree` (reconcile + clone) is the fix.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { unwrap } from "solid-js/store";
import { createRoot } from "solid-js";
import { computeLayout } from "../lib/layout";
import {
  activeWorkspace,
  appState,
  canMovePane,
  createWorkspace,
  splitPane,
  closePane,
  switchWorkspace,
  setPaneRole,
  activeRolePanes,
  renamePane,
  setPaneSessionId,
  movePaneToWorkspace,
  movePaneToNewWorkspace,
  movePaneBeside,
} from "./workspace";
import { claimFile, listClaims } from "./claims";
import { gatePane, isGated } from "./inputHolds";
import type { LayoutNode, PaneId } from "../ipc/protocol";

// The move ops import the tear-off/redock helpers from lib/detach; mock them so the store's
// detached-pane guard is test-controllable and the PTY handoff (a Tauri/window concern) is a no-op.
// `hoisted.detached` holds the PaneIds a test wants to look torn-off.
const hoisted = vi.hoisted(() => ({ detached: new Set<number>() }));
vi.mock("../lib/detach", () => ({
  isDetachedPlaceholder: (id: number) => hoisted.detached.has(id),
  preservePtyForMove: () => {},
}));

/** A workspace from the live store by id (throws if gone — e.g. auto-closed). */
const wsById = (id: string) => appState.workspaces.find((w) => w.id === id)!;
/** Leaf pane-ids of workspace `id`, in layout order. */
const leavesOf = (id: string): PaneId[] => computeLayout(unwrap(wsById(id).tree)).leaves.map((l) => l.paneId);

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

// Backs the FleetPanel role roster/filter (ORCHESTRATION §2): activeRolePanes is the reactive data
// source the panel groups by role, so it must reflect setPaneRole writes in layout order.
describe("workspace store: activeRolePanes reflects per-pane roles", () => {
  beforeEach(() => {
    createRoot(() => {
      const id = createWorkspace({ name: `r-${Math.random()}`, cwd: "", paneCount: 3 });
      switchWorkspace(id);
    });
  });

  it("lists every leaf pane in layout order with its role (undefined when unset)", () => {
    createRoot(() => {
      const ids = leaves();
      setPaneRole(ids[0], "builder");
      setPaneRole(ids[2], "Reviewer");

      const roster = activeRolePanes();
      expect(roster.map((p) => p.paneId)).toEqual(ids);
      expect(roster.map((p) => p.role)).toEqual(["builder", undefined, "Reviewer"]);
      // Names always resolve; focus flag tracks the active workspace's focused pane.
      expect(roster.every((p) => typeof p.name === "string")).toBe(true);
      expect(roster.filter((p) => p.focused).length).toBeLessThanOrEqual(1);
    });
  });

  it("clears a role back to undefined when set to blank (roster drops it to unassigned)", () => {
    createRoot(() => {
      const ids = leaves();
      setPaneRole(ids[1], "scout");
      expect(activeRolePanes()[1].role).toBe("scout");
      setPaneRole(ids[1], "  ");
      expect(activeRolePanes()[1].role).toBeUndefined();
    });
  });
});

// Moving panes across / within workspaces (docs/roadmap/plans/01-move-panes.md). The store is a
// module singleton, so each test builds its own workspaces and asserts by id (never absolute index).
describe("workspace store: move panes across / within workspaces", () => {
  beforeEach(() => hoisted.detached.clear());

  it("movePaneToWorkspace transfers the pane, preserves its identity/gate, releases source claims", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1, a2] = leavesOf(A);
      // Give the mover a distinct title + a Session id (identity) + a gate + a file claim.
      renamePane(a1, "Mover");
      setPaneSessionId(a1, "sess-123");
      gatePane(a1, "op");
      claimFile(A, "/repo/file.ts", "Mover");
      switchWorkspace(A); // source is the active view

      movePaneToWorkspace(a1, B);

      // Source keeps its other pane; the mover is gone and focus re-points to the survivor.
      expect(leavesOf(A)).toEqual([a2]);
      expect(a1 in wsById(A).panes).toBe(false);
      expect(wsById(A).focused).toBe(a2);
      // Target owns the same PaneId + spec (Session survives), focused on arrival, zoom cleared.
      expect(leavesOf(B)).toContain(a1);
      expect(wsById(B).panes[a1].sessionId).toBe("sess-123");
      expect(wsById(B).focused).toBe(a1);
      expect(wsById(B).zoomed).toBeNull();
      // Gate is PaneId-keyed → travels for free; claims are workspace-keyed → released under source.
      expect(isGated(a1)).toBe(true);
      expect(listClaims(A).some((c) => c.path === "/repo/file.ts")).toBe(false);
      // Source survived, so the view stays put (decision 2).
      expect(appState.activeId).toBe(A);
    });
  });

  it("auto-closes an emptied source and follows the view to the target (decisions 1 & 2)", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 1 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1] = leavesOf(A);
      const [b1] = leavesOf(B);
      switchWorkspace(A); // moving A's only pane empties + auto-closes A

      movePaneToWorkspace(a1, B);

      expect(appState.workspaces.some((w) => w.id === A)).toBe(false); // A removed, no confirm/history
      expect(appState.activeId).toBe(B); // view followed to the target
      expect(leavesOf(B).sort()).toEqual([a1, b1].sort());
      expect(appState.workspaces.length).toBeGreaterThanOrEqual(1); // never stranded at zero
    });
  });

  it("keeps the view on a third workspace when a non-active source auto-closes", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 1 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const C = createWorkspace({ name: `C-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1] = leavesOf(A);
      switchWorkspace(C); // viewing C, not the source

      movePaneToWorkspace(a1, B);

      expect(appState.workspaces.some((w) => w.id === A)).toBe(false);
      expect(appState.activeId).toBe(C); // view unchanged — the source wasn't active
    });
  });

  it("movePaneToNewWorkspace makes a fresh single-leaf workspace from the pane", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const [a1, a2] = leavesOf(A);
      renamePane(a1, "Solo");
      setPaneSessionId(a1, "sess-solo");
      const before = appState.workspaces.length;

      movePaneToNewWorkspace(a1, "Detached team");

      expect(appState.workspaces.length).toBe(before + 1);
      const fresh = appState.workspaces.find((w) => w.name === "Detached team")!;
      expect(fresh).toBeTruthy();
      expect(leavesOf(fresh.id)).toEqual([a1]); // the pane is the new workspace's only leaf
      expect(fresh.panes[a1].sessionId).toBe("sess-solo"); // spec carried over intact
      expect(leavesOf(A)).toEqual([a2]); // source keeps its other pane
    });
  });

  it("movePaneBeside within a workspace is a tree-only reposition (side ordering)", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const [a1, a2] = leavesOf(A);
      const keysBefore = Object.keys(wsById(A).panes).sort();

      movePaneBeside(a1, a2, "down"); // a1 lands *below* a2 → col split, a=a2, b=a1

      const root = unwrap(wsById(A).tree);
      expect(root.kind).toBe("split");
      if (root.kind === "split") {
        expect(root.dir).toBe("col");
        expect(root.a).toEqual({ kind: "leaf", paneId: a2 });
        expect(root.b).toEqual({ kind: "leaf", paneId: a1 });
      }
      // The panes map is untouched (no ownership change, no remount).
      expect(Object.keys(wsById(A).panes).sort()).toEqual(keysBefore);
    });
  });

  it("movePaneBeside 'left' puts the moved pane in child a (row split)", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const [a1, a2] = leavesOf(A);

      movePaneBeside(a1, a2, "left"); // a1 to the left of a2 → row split, a=a1, b=a2

      const root = unwrap(wsById(A).tree);
      if (root.kind === "split") {
        expect(root.dir).toBe("row");
        expect(root.a).toEqual({ kind: "leaf", paneId: a1 });
        expect(root.b).toEqual({ kind: "leaf", paneId: a2 });
      }
    });
  });

  it("movePaneBeside across workspaces inserts beside the target with the right side", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1, a2] = leavesOf(A);
      const [b1] = leavesOf(B);

      movePaneBeside(a1, b1, "up"); // a1 above b1 in B → col split, a=a1, b=b1

      expect(leavesOf(A)).toEqual([a2]); // left the source
      const root = unwrap(wsById(B).tree);
      if (root.kind === "split") {
        expect(root.dir).toBe("col");
        expect(root.a).toEqual({ kind: "leaf", paneId: a1 });
        expect(root.b).toEqual({ kind: "leaf", paneId: b1 });
      }
      expect(wsById(B).focused).toBe(a1);
    });
  });

  it("renames on title collision (claim released by original title, insert keyed on the new one)", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1] = leavesOf(A);
      const [b1] = leavesOf(B);
      renamePane(a1, "Dup");
      renamePane(b1, "Dup"); // target already has this title → arrival must be renamed
      claimFile(A, "/repo/x.ts", "Dup");

      movePaneToWorkspace(a1, B);

      expect(wsById(B).panes[a1].title).not.toBe("Dup"); // renamed via allocName on arrival
      expect(wsById(B).panes[b1].title).toBe("Dup"); // the incumbent keeps its name
      expect(listClaims(A).some((c) => c.path === "/repo/x.ts")).toBe(false); // released by "Dup"
    });
  });

  it("canMovePane is false for a torn-off pane, and the move is a no-op", () => {
    createRoot(() => {
      const A = createWorkspace({ name: `A-${Math.random()}`, cwd: "", paneCount: 2 });
      const B = createWorkspace({ name: `B-${Math.random()}`, cwd: "", paneCount: 1 });
      const [a1, a2] = leavesOf(A);
      expect(canMovePane(a1)).toBe(true);

      hoisted.detached.add(a1); // pretend a1 is torn off into its own window
      expect(canMovePane(a1)).toBe(false);

      movePaneToWorkspace(a1, B); // blocked
      expect(leavesOf(A).sort()).toEqual([a1, a2].sort()); // unchanged
      expect(a1 in wsById(B).panes).toBe(false);
    });
  });
});

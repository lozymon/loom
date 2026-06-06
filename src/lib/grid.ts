// Layout-tree constructors + pane naming.
//
// `buildBalancedTree(n)` is the width-biased grid used by the M3 wizard's preset tiles
// (and as M2's initial demo layout). Names come from a curated pool so a fleet of panes
// running the *same* command stays distinguishable (CLAUDE.md / PLAN "Layout model").

import type { LayoutNode } from "../ipc/protocol";

/** Curated short, distinct human names. Overflow falls back to `Pane N`. */
export const NAME_POOL = [
  "Faye", "Cleo", "Wade", "Iris", "Otto", "Nora",
  "Gus", "Vera", "Milo", "Edie", "Hugo", "Lena",
  "Remy", "Suki", "Cody", "Mira", "Zane", "Posy",
];

/** First pool name not in `taken`, else the lowest free `Pane N`. */
export function allocName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (const name of NAME_POOL) if (!used.has(name)) return name;
  let i = 1;
  while (used.has(`Pane ${i}`)) i++;
  return `Pane ${i}`;
}

/** Right-leaning binary chain of `items` along `dir`, with ratios giving equal sizes. */
function chain(items: LayoutNode[], dir: "row" | "col"): LayoutNode {
  if (items.length === 1) return items[0];
  // First item gets 1/n; the rest share the remainder and are split equally in turn.
  return {
    kind: "split",
    dir,
    ratio: 1 / items.length,
    a: items[0],
    b: chain(items.slice(1), dir),
  };
}

/**
 * Build a width-biased balanced tree of `n` leaves: `rows = floor(√n)` bands stacked
 * top-to-bottom (`col`), each band a row of side-by-side leaves (`row`). `makeLeaf` is
 * called once per leaf, in row-major order, so callers can allocate pane ids/specs.
 */
export function buildBalancedTree(n: number, makeLeaf: () => LayoutNode): LayoutNode {
  const count = Math.max(1, Math.floor(n));
  const rows = Math.max(1, Math.floor(Math.sqrt(count)));
  const leaves = Array.from({ length: count }, makeLeaf);

  const bands: LayoutNode[] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    // Spread the remaining leaves evenly across the remaining bands.
    const take = Math.ceil((count - idx) / (rows - r));
    bands.push(chain(leaves.slice(idx, idx + take), "row"));
    idx += take;
  }
  return chain(bands, "col");
}

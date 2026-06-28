// Renders one workspace's layout tree. Despite the name, this is NOT a recursive flex tree:
// it flattens the tree (lib/layout) into one absolutely-positioned, PaneId-keyed layer of
// panes plus a layer of draggable gutters. That flat layer is what keeps a leaf's PTY alive
// across splits/closes — a recursive renderer would remount the <Terminal> and respawn it.

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { appState, focusPane, setOverview, setRatio, swapPanes, type WorkspaceUI } from "../stores/workspace";
import { computeLayout, type GutterBox, type Rect } from "../lib/layout";
import { isDetachedPlaceholder, recallPane } from "../lib/detach";
import type { PaneId } from "../ipc/protocol";
import TerminalPane from "./Terminal";
import EmptyWorkspace from "./EmptyWorkspace";

export default function LayoutView(props: { ws: WorkspaceUI }) {
  let root!: HTMLDivElement;

  const layout = createMemo(() => computeLayout(props.ws.tree));
  const paneIds = createMemo(() => Object.keys(props.ws.panes).map(Number) as PaneId[]);
  const rectOf = (id: PaneId): Rect | undefined => layout().leaves.find((l) => l.paneId === id)?.rect;

  const overview = () => appState.overview;
  // Which overview tile a drag is currently hovering (for the drop highlight).
  const [dragOverId, setDragOverId] = createSignal<PaneId | null>(null);

  // Overview ("fleet glance"): reflow every pane into a uniform tile grid, ordered top-to-bottom
  // then left-to-right (reading order) by their tree position so the wall is stable. Pure
  // re-positioning of the existing flat leaf-boxes — no DOM re-parenting, so the PTYs/xterm
  // instances are untouched (the resize observer refits each one to its new tile).
  const overviewPos = createMemo(() => {
    const leaves = [...layout().leaves].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const n = leaves.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const gap = 0.8; // percent inset per tile, for breathing room between tiles
    const m = new Map<PaneId, JSX.CSSProperties>();
    leaves.forEach((l, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const w = 100 / cols;
      const h = 100 / rows;
      m.set(l.paneId, {
        left: `calc(${c * w}% + ${gap}%)`,
        top: `calc(${r * h}% + ${gap}%)`,
        width: `calc(${w}% - ${2 * gap}%)`,
        height: `calc(${h}% - ${2 * gap}%)`,
        display: "block",
      });
    });
    return m;
  });

  /** Position for a pane box: a uniform tile in overview, full-bleed when zoomed, tree rect otherwise. */
  function paneStyle(id: PaneId): JSX.CSSProperties {
    if (overview()) return overviewPos().get(id) ?? { display: "none" };
    const zoomed = props.ws.zoomed;
    if (zoomed !== null) {
      return zoomed === id ? { inset: "0", display: "block" } : { display: "none" };
    }
    const r = rectOf(id);
    if (!r) return { display: "none" };
    return { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`, display: "block" };
  }

  /** Convert a pointer drag on a gutter into a new ratio for its split. */
  function onGutterDown(g: GutterBox, e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const box = root.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio =
        g.dir === "row"
          ? ((ev.clientX - box.left) / box.width) * 100 - g.splitRect.x
          : ((ev.clientY - box.top) / box.height) * 100 - g.splitRect.y;
      const denom = g.dir === "row" ? g.splitRect.w : g.splitRect.h;
      setRatio(props.ws.id, g.path, ratio / denom);
    };
    const up = (ev: PointerEvent) => {
      (e.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div ref={root} class="layout-root" classList={{ overview: overview() }}>
      <Show when={paneIds().length === 0}>
        <EmptyWorkspace
          onChooseLayout={() => window.dispatchEvent(new CustomEvent("loom:new-workspace"))}
        />
      </Show>
      <For each={paneIds()}>
        {(id) => (
          <div class="leaf-box" style={paneStyle(id)}>
            <Show
              when={!isDetachedPlaceholder(id)}
              fallback={
                <div class="pane detached-pane">
                  <div class="detached-msg">
                    <div class="detached-title">◳ Torn off</div>
                    <div class="detached-sub">This pane is open in its own window.</div>
                    <button class="detached-recall" onClick={() => void recallPane(id)}>Bring it back</button>
                  </div>
                </div>
              }
            >
              <TerminalPane paneId={id} ws={props.ws} />
            </Show>
          </div>
        )}
      </For>

      {/* In overview, a transparent hit-target over each tile: click focuses that pane and drops
          back to the split grid (and stops a stray click from typing into the xterm beneath).
          Dragging one tile onto another swaps their grid positions (reuses swapPanes). */}
      <Show when={overview()}>
        <For each={paneIds()}>
          {(id) => (
            <button
              class="overview-hit"
              classList={{ "drag-over": dragOverId() === id }}
              style={paneStyle(id)}
              title="Click to focus · drag onto another tile to swap"
              draggable={true}
              onDragStart={(e) => {
                e.dataTransfer?.setData("text/plain", String(id));
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => { e.preventDefault(); if (dragOverId() !== id) setDragOverId(id); }}
              onDragLeave={() => { if (dragOverId() === id) setDragOverId(null); }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverId(null);
                const src = Number(e.dataTransfer?.getData("text/plain"));
                if (src) swapPanes(src, id);
              }}
              onClick={() => { focusPane(id); setOverview(false); }}
            />
          )}
        </For>
      </Show>

      <For each={props.ws.zoomed === null && !overview() ? layout().gutters : []}>
        {(g) => (
          <div
            class="gutter"
            classList={{ "gutter-row": g.dir === "row", "gutter-col": g.dir === "col" }}
            style={
              g.dir === "row"
                ? { left: `${g.pos}%`, top: `${g.splitRect.y}%`, height: `${g.splitRect.h}%` }
                : { top: `${g.pos}%`, left: `${g.splitRect.x}%`, width: `${g.splitRect.w}%` }
            }
            onPointerDown={(e) => onGutterDown(g, e)}
          />
        )}
      </For>
    </div>
  );
}

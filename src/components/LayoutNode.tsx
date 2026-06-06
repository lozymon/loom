// Renders one workspace's layout tree. Despite the name, this is NOT a recursive flex tree:
// it flattens the tree (lib/layout) into one absolutely-positioned, PaneId-keyed layer of
// panes plus a layer of draggable gutters. That flat layer is what keeps a leaf's PTY alive
// across splits/closes — a recursive renderer would remount the <Terminal> and respawn it.

import { createMemo, For } from "solid-js";
import { setRatio, type WorkspaceUI } from "../stores/workspace";
import { computeLayout, type GutterBox, type Rect } from "../lib/layout";
import type { PaneId } from "../ipc/protocol";
import TerminalPane from "./Terminal";

export default function LayoutView(props: { ws: WorkspaceUI }) {
  let root!: HTMLDivElement;

  const layout = createMemo(() => computeLayout(props.ws.tree));
  const paneIds = createMemo(() => Object.keys(props.ws.panes).map(Number) as PaneId[]);
  const rectOf = (id: PaneId): Rect | undefined => layout().leaves.find((l) => l.paneId === id)?.rect;

  /** Position for a pane box: full-bleed when zoomed, its tree rect otherwise. */
  function paneStyle(id: PaneId) {
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
    <div ref={root} class="layout-root">
      <For each={paneIds()}>
        {(id) => (
          <div class="leaf-box" style={paneStyle(id)}>
            <TerminalPane paneId={id} ws={props.ws} />
          </div>
        )}
      </For>

      <For each={props.ws.zoomed === null ? layout().gutters : []}>
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

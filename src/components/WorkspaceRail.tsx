// Left vertical workspace rail: one entry per workspace (name + live terminal-count badge
// + close ✕), the active one highlighted. Switching keeps hidden workspaces' PTYs alive;
// closing removes a workspace (PTYs die). App actions (New/Save/Settings/Source control)
// live in the top title bar, not here.

import { createSignal, For, Show } from "solid-js";
import { appState, paneCount, switchWorkspace, closeWorkspace, renameWorkspace, duplicateWorkspace } from "../stores/workspace";
import { anyAttention, anyNeedsAttention } from "../stores/activity";
import { settings, setSetting } from "../stores/settings";

const RAIL_MIN = 120;
const RAIL_MAX = 420;

/** A stable hue (0–359) derived from a workspace id, so each row's icon gets its own color. */
function wsHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export default function WorkspaceRail(props: { onNew: () => void }) {
  // Which workspace row is mid-rename (double-click the name to enter, Enter/blur commits, Esc cancels).
  const [editingId, setEditingId] = createSignal<string | null>(null);

  // Drag the right edge to resize; clamp to a sane range and persist the new width.
  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.railWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(RAIL_MIN, Math.min(RAIL_MAX, startW + (ev.clientX - startX)));
      setSetting("railWidth", w);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <nav class="rail" style={{ "flex-basis": `${settings.railWidth}px`, width: `${settings.railWidth}px` }}>
      <div class="rail-header">
        <span class="rail-title">Workspaces</span>
        <button class="rail-add" title="New workspace (Ctrl+Shift+T)" onClick={() => props.onNew()}>＋</button>
      </div>
      <div class="rail-list">
        <For each={appState.workspaces}>
          {(ws) => {
            // Two signals for a hidden workspace (the active one shows per-pane indicators):
            //   • activity  — a pane produced unseen output / rang the bell → lighter amber dot.
            //   • attention — a pane raised the sticky "needs you" flag → amber border on the row.
            const isHidden = () => ws.id !== appState.activeId;
            const paneIds = () => Object.keys(ws.panes).map(Number);
            const hasActivity = () => isHidden() && anyAttention(paneIds());
            const needsAttention = () => isHidden() && anyNeedsAttention(paneIds());
            const hue = wsHue(ws.id);
            return (
              <div
                class="rail-item"
                classList={{ active: ws.id === appState.activeId, attention: needsAttention() }}
                onClick={() => switchWorkspace(ws.id)}
                title={ws.cwd || ws.name}
              >
                {/* Per-workspace colored icon chip — a little terminal glyph tinted by hue. */}
                <span
                  class="rail-icon"
                  style={{
                    color: `hsl(${hue} 70% 72%)`,
                    background: `hsl(${hue} 45% 50% / 0.18)`,
                    "border-color": `hsl(${hue} 50% 55% / 0.45)`,
                  }}
                >
                  ❯
                </span>
                <Show
                  when={editingId() === ws.id}
                  fallback={
                    <span
                      class="rail-name"
                      title="Double-click to rename"
                      onDblClick={(e) => { e.stopPropagation(); setEditingId(ws.id); }}
                    >
                      {ws.name}
                    </span>
                  }
                >
                  <input
                    class="rail-name-edit"
                    value={ws.name}
                    ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { renameWorkspace(ws.id, e.currentTarget.value); setEditingId(null); }
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={(e) => { renameWorkspace(ws.id, e.currentTarget.value); setEditingId(null); }}
                  />
                </Show>
                <Show when={hasActivity()}>
                  <span class="rail-attn" title="Activity in this workspace" />
                </Show>
                <span class="rail-badge">{paneCount(ws)}</span>
                <button
                  class="rail-dup"
                  title="Duplicate workspace (same layout + commands)"
                  onClick={(e) => { e.stopPropagation(); duplicateWorkspace(ws.id); }}
                >
                  ⧉
                </button>
                <button
                  class="rail-close"
                  title="Close workspace"
                  onClick={(e) => { e.stopPropagation(); closeWorkspace(ws.id); }}
                >
                  ✕
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <div class="rail-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
    </nav>
  );
}

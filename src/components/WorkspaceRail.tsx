// Left vertical workspace rail: one entry per workspace (name + live terminal-count badge
// + close ✕), the active one highlighted. Switching keeps hidden workspaces' PTYs alive;
// closing removes a workspace (PTYs die). App actions (New/Save/Settings/Source control)
// live in the top title bar, not here.

import { createSignal, For, Show } from "solid-js";
import { MOD_NAMESPACE } from "../lib/keybindings";
import { appState, paneCount, switchWorkspace, closeWorkspace, renameWorkspace, duplicateWorkspace } from "../stores/workspace";
import { anyAttention, anyNeedsAttention, countNeedsAttention } from "../stores/activity";
import { settings, setSetting } from "../stores/settings";

const RAIL_MIN = 120;
const RAIL_MAX = 420;
const RAIL_COLLAPSED = 56;

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

  const collapsed = () => settings.railCollapsed;
  const railWidth = () => (collapsed() ? RAIL_COLLAPSED : settings.railWidth);
  const toggleCollapse = () => setSetting("railCollapsed", !collapsed());

  return (
    <nav
      class="rail"
      classList={{ collapsed: collapsed() }}
      style={{ "flex-basis": `${railWidth()}px`, width: `${railWidth()}px` }}
    >
      <div class="rail-header">
        <span class="rail-title">Workspaces</span>
        <button
          class="rail-collapse"
          title={collapsed() ? "Expand rail" : "Collapse rail"}
          onClick={toggleCollapse}
        >
          {collapsed() ? "»" : "«"}
        </button>
      </div>
      <div class="rail-list">
        <For each={appState.workspaces}>
          {(ws) => {
            // The row's live dot: amber when a hidden pane needs you, green on background activity,
            // grey at rest. Derived from the activity store — never pane output (ADR-0001).
            // Two signals for a hidden workspace (the active one shows per-pane indicators):
            //   • activity  — a pane produced unseen output / rang the bell → lighter amber dot.
            //   • attention — a pane raised the sticky "needs you" flag → amber border on the row.
            const isHidden = () => ws.id !== appState.activeId;
            const paneIds = () => Object.keys(ws.panes).map(Number);
            const hasActivity = () => isHidden() && anyAttention(paneIds());
            const needsAttention = () => isHidden() && anyNeedsAttention(paneIds());
            // How many panes in this group are asking for you — drives the amber count pill.
            // Counted for active *and* hidden workspaces: on the active one it drains as you
            // focus each flagged pane (seePane clears attention). 0 → the pill isn't drawn.
            const needsCount = () => countNeedsAttention(paneIds());
            const dotState = () =>
              needsAttention() ? "needs" : hasActivity() ? "working" : "idle";
            return (
              <div
                class="rail-item"
                classList={{ active: ws.id === appState.activeId, attention: needsAttention() }}
                onClick={() => switchWorkspace(ws.id)}
                title={ws.cwd || ws.name}
              >
                {/* Live state dot (expanded) / first-letter avatar tinted by state (collapsed). */}
                <span class="rail-dot" data-state={dotState()} />
                <span class="rail-initial" data-state={dotState()}>
                  {(ws.name.trim()[0] ?? "?").toUpperCase()}
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
                <Show when={needsCount() > 0}>
                  <span
                    class="rail-attn-pill"
                    title={`${needsCount()} pane${needsCount() === 1 ? "" : "s"} need${needsCount() === 1 ? "s" : ""} your attention`}
                  >
                    {needsCount()}
                  </span>
                </Show>
                <span class="rail-badge">{paneCount(ws)}</span>
                <span class="wsact">
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
                </span>
              </div>
            );
          }}
        </For>
        <button class="rail-new" title={`New workspace (${MOD_NAMESPACE}+T)`} onClick={() => props.onNew()}>
          <span class="rail-new-plus">＋</span> New workspace
        </button>
      </div>
      <Show when={!collapsed()}>
        <div class="rail-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
      </Show>
    </nav>
  );
}

// Left vertical workspace rail: one entry per workspace (name + live terminal-count badge
// + close ✕), the active one highlighted. Switching keeps hidden workspaces' PTYs alive;
// closing removes a workspace (PTYs die). App actions (New/Save/Settings/Source control)
// live in the top title bar, not here.

import { For, Show } from "solid-js";
import { appState, paneCount, switchWorkspace, closeWorkspace } from "../stores/workspace";
import { anyAttention } from "../stores/activity";

export default function WorkspaceRail() {
  return (
    <nav class="rail">
      <div class="rail-list">
        <For each={appState.workspaces}>
          {(ws) => (
            <div
              class="rail-item"
              classList={{ active: ws.id === appState.activeId }}
              onClick={() => switchWorkspace(ws.id)}
              title={ws.cwd || ws.name}
            >
              {/* Attention dot for hidden workspaces — a pane there rang the bell or produced
                  output you haven't seen. The active workspace shows per-pane dots instead. */}
              <Show when={ws.id !== appState.activeId && anyAttention(Object.keys(ws.panes).map(Number))}>
                <span class="rail-attn" title="Activity in this workspace" />
              </Show>
              <span class="rail-name">{ws.name}</span>
              <span class="rail-badge">{paneCount(ws)}</span>
              <button
                class="rail-close"
                title="Close workspace"
                onClick={(e) => { e.stopPropagation(); closeWorkspace(ws.id); }}
              >
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
    </nav>
  );
}

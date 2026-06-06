// Left vertical workspace rail: one entry per workspace (name + live terminal-count badge
// + close ✕), the active one highlighted; a + at the bottom opens the new-workspace flow.
// Switching keeps hidden workspaces' PTYs alive; closing removes a workspace (PTYs die).

import { For } from "solid-js";
import { appState, paneCount, switchWorkspace, closeWorkspace, saveCurrentAsPreset } from "../stores/workspace";

export default function WorkspaceRail(props: { onNew: () => void; onSettings: () => void; onGit: () => void }) {
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
      <button class="rail-settings" title="Source control (Ctrl+Shift+G)" onClick={() => props.onGit()}>
        ⎇ Source control
      </button>
      <button class="rail-settings" title="Settings" onClick={() => props.onSettings()}>
        ⚙ Settings
      </button>

      <div class="rail-foot">
        <button
          class="rail-save"
          title="Save active workspace as a preset"
          onClick={() => saveCurrentAsPreset()}
        >
          ⛁ Save
        </button>
        <button class="rail-new" title="New workspace" onClick={() => props.onNew()}>＋</button>
      </div>
    </nav>
  );
}

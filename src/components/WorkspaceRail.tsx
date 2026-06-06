// Left vertical workspace rail: one entry per workspace (name + live terminal-count badge
// + close ✕), the active one highlighted; a + at the bottom opens the new-workspace flow.
// Switching keeps hidden workspaces' PTYs alive; closing removes a workspace (PTYs die).

import { For } from "solid-js";
import { appState, paneCount, switchWorkspace, closeWorkspace, saveCurrentAsPreset } from "../stores/workspace";
import { themes, themeId, setTheme } from "../stores/theme";

export default function WorkspaceRail(props: { onNew: () => void }) {
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
      <label class="rail-theme" title="Theme">
        <span>◐</span>
        <select value={themeId()} onChange={(e) => setTheme(e.currentTarget.value)}>
          <For each={themes}>{(t) => <option value={t.id}>{t.name}</option>}</For>
        </select>
      </label>

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

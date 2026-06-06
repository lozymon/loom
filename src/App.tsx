// M3 shell: left workspace rail | stage of workspace layers. Every workspace renders into
// its own absolutely-filled layer; only the active one is shown (the rest stay mounted so
// their PTYs survive hiding). The + on the rail opens the new-workspace wizard.
//
// Rendering waits for init() to hydrate persisted state, so panes spawn exactly once against
// the restored layout (no spawn-then-replace), then startPersistence() autosaves changes.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import WorkspaceRail from "./components/WorkspaceRail";
import LayoutView from "./components/LayoutNode";
import NewWorkspaceWizard from "./components/NewWorkspaceWizard";
import BroadcastBar from "./components/BroadcastBar";
import Settings from "./components/Settings";
import { appState, init, startPersistence, flushPersistence } from "./stores/workspace";
import { initTheme } from "./stores/theme";
import { initSettings } from "./stores/settings";
import "./App.css";

export default function App() {
  const [wizardOpen, setWizardOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    await Promise.all([initTheme(), initSettings(), init()]);
    startPersistence();
    setReady(true);
  });

  // Ctrl+Shift+T from a focused pane (ADR-0005) opens the new-workspace wizard.
  const openWizard = () => setWizardOpen(true);
  window.addEventListener("termhaus:new-workspace", openWizard);
  onCleanup(() => window.removeEventListener("termhaus:new-workspace", openWizard));

  // Flush any debounced state, then close. preventDefault() must run synchronously so the
  // window waits for us; we destroy it ourselves once the final save resolves.
  const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    try { await flushPersistence(); } finally { await getCurrentWindow().destroy(); }
  });
  onCleanup(() => { void unlistenClose.then((u) => u()); });

  return (
    <div class="shell">
      <WorkspaceRail onNew={() => setWizardOpen(true)} onSettings={() => setSettingsOpen(true)} />
      <div class="stage">
        <div class="stage-grid">
          <Show when={ready()}>
            <For each={appState.workspaces}>
              {(ws) => (
                <div class="ws-layer" style={{ display: ws.id === appState.activeId ? "block" : "none" }}>
                  <LayoutView ws={ws} />
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={ready()}>
          <BroadcastBar />
        </Show>
      </div>
      <Show when={wizardOpen()}>
        <NewWorkspaceWizard onClose={() => setWizardOpen(false)} />
      </Show>
      <Show when={settingsOpen()}>
        <Settings onClose={() => setSettingsOpen(false)} />
      </Show>
    </div>
  );
}

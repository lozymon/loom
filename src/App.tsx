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
import GitPanel from "./components/GitPanel";
import CommandPalette from "./components/CommandPalette";
import { appState, init, startPersistence, flushPersistence, setOverview } from "./stores/workspace";
import { initTheme } from "./stores/theme";
import { initSettings } from "./stores/settings";
import { initPaneControl } from "./lib/paneControl";
import "./App.css";

export default function App() {
  const [wizardOpen, setWizardOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [gitOpen, setGitOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    await Promise.all([initTheme(), initSettings(), init()]);
    startPersistence();
    setReady(true);
  });

  // Listen for inter-pane control requests (the `th` CLI → Rust relay → here). Registered in
  // the component body (not the async onMount) so onCleanup keeps its owner context.
  const unlistenCtrl = initPaneControl();
  onCleanup(() => { void unlistenCtrl.then((u) => u()); });

  // Ctrl+Shift+T from a focused pane (ADR-0005) opens the new-workspace wizard.
  const openWizard = () => setWizardOpen(true);
  window.addEventListener("termhaus:new-workspace", openWizard);
  onCleanup(() => window.removeEventListener("termhaus:new-workspace", openWizard));

  // Ctrl+Shift+G from a focused pane opens the Source Control (git diff) panel.
  const openGit = () => setGitOpen(true);
  window.addEventListener("termhaus:source-control", openGit);
  onCleanup(() => window.removeEventListener("termhaus:source-control", openGit));

  // Ctrl+Shift+P opens the command palette (toggles so a second press closes it).
  const openPalette = () => setPaletteOpen((v) => !v);
  window.addEventListener("termhaus:command-palette", openPalette);
  onCleanup(() => window.removeEventListener("termhaus:command-palette", openPalette));

  // Esc leaves overview mode. Capture phase + stopImmediatePropagation so the keystroke never
  // reaches the focused xterm beneath (it would otherwise be typed into the shell).
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && appState.overview) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setOverview(false);
    }
  };
  window.addEventListener("keydown", onEsc, true);
  onCleanup(() => window.removeEventListener("keydown", onEsc, true));

  // Flush any debounced state, then close. preventDefault() must run synchronously so the
  // window waits for us; we destroy it ourselves once the final save resolves.
  const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    try { await flushPersistence(); } finally { await getCurrentWindow().destroy(); }
  });
  onCleanup(() => { void unlistenClose.then((u) => u()); });

  return (
    <div class="shell">
      <WorkspaceRail
        onNew={() => setWizardOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onGit={() => setGitOpen(true)}
      />
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
      <Show when={gitOpen()}>
        <GitPanel onClose={() => setGitOpen(false)} />
      </Show>
      <Show when={paletteOpen()}>
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNewWorkspace={() => setWizardOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onGit={() => setGitOpen(true)}
        />
      </Show>
    </div>
  );
}

// M3 shell: left workspace rail | stage of workspace layers. Every workspace renders into
// its own absolutely-filled layer; only the active one is shown (the rest stay mounted so
// their PTYs survive hiding). The + on the rail opens the new-workspace wizard.
//
// Rendering waits for init() to hydrate persisted state, so panes spawn exactly once against
// the restored layout (no spawn-then-replace), then startPersistence() autosaves changes.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import WorkspaceRail from "./components/WorkspaceRail";
import LayoutView from "./components/LayoutNode";
import NewWorkspaceWizard from "./components/NewWorkspaceWizard";
import BroadcastBar from "./components/BroadcastBar";
import Settings from "./components/Settings";
import GitPanel from "./components/GitPanel";
import CommandPalette from "./components/CommandPalette";
import {
  appState, init, startPersistence, flushPersistence,
  setOverview, toggleOverview, switchWorkspaceRelative,
} from "./stores/workspace";
import { initTheme } from "./stores/theme";
import { initSettings, settings } from "./stores/settings";
import { actionForKey, isModifierKey, type ActionId } from "./lib/keybindings";
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

  // Ctrl+Shift+, from a focused pane opens Settings.
  const openSettings = () => setSettingsOpen(true);
  window.addEventListener("termhaus:settings", openSettings);
  onCleanup(() => window.removeEventListener("termhaus:settings", openSettings));

  // Ctrl+Shift+P opens the command palette (toggles so a second press closes it).
  const openPalette = () => setPaletteOpen((v) => !v);
  window.addEventListener("termhaus:command-palette", openPalette);
  onCleanup(() => window.removeEventListener("termhaus:command-palette", openPalette));

  // Global fallback for the app-level Ctrl+Shift shortcuts. Terminal.tsx intercepts these via
  // xterm's key handler, but that only fires while a *terminal* owns focus — so when focus is on
  // the rail, a dialog, a button, or nothing, the shortcuts would otherwise be dead. This window
  // listener covers that gap. Pane-scoped actions (focus/split/close/zoom/copy/paste/…) need a
  // focused pane and stay terminal-only; only workspace/app actions are wired here.
  const GLOBAL_ACTIONS: Partial<Record<ActionId, () => void>> = {
    "new-workspace": () => setWizardOpen(true),
    "settings": () => setSettingsOpen(true),
    "source-control": () => setGitOpen(true),
    "command-palette": () => setPaletteOpen((v) => !v),
    "overview": () => toggleOverview(),
    "prev-workspace": () => switchWorkspaceRelative(-1),
    "next-workspace": () => switchWorkspaceRelative(1),
  };
  const onGlobalKey = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if (isModifierKey(e.key)) return;
    // When a terminal has focus, its own handler runs these — bail so we don't double-fire.
    if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
    const action = actionForKey(settings.keybindings, e.key);
    const run = action && GLOBAL_ACTIONS[action];
    if (!run) return;
    e.preventDefault();
    run();
  };
  window.addEventListener("keydown", onGlobalKey);
  onCleanup(() => window.removeEventListener("keydown", onGlobalKey));

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
      <TitleBar
        onSettings={() => setSettingsOpen(true)}
        onGit={() => setGitOpen(true)}
      />
      <div class="body">
      <WorkspaceRail onNew={() => setWizardOpen(true)} />
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

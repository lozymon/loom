// M3 shell: left workspace rail | stage of workspace layers. Every workspace renders into
// its own absolutely-filled layer; only the active one is shown (the rest stay mounted so
// their PTYs survive hiding). The + on the rail opens the full-stage new-workspace launcher.
//
// Rendering waits for init() to hydrate persisted state, so panes spawn exactly once against
// the restored layout (no spawn-then-replace), then startPersistence() autosaves changes.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/TitleBar";
import WorkspaceRail from "./components/WorkspaceRail";
import LayoutView from "./components/LayoutNode";
import NewWorkspaceLauncher from "./components/NewWorkspaceLauncher";
import FleetApprovals from "./components/FleetApprovals";
import Settings from "./components/Settings";
import GitPanel from "./components/GitPanel";
import DocsPanel from "./components/DocsPanel";
import FleetPanel from "./components/FleetPanel";
import BoardPanel from "./components/BoardPanel";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import SessionLogViewer from "./components/SessionLogViewer";
import HistorySearch from "./components/HistorySearch";
import ReopenPanel from "./components/ReopenPanel";
import CommandPalette from "./components/CommandPalette";
import ListeningOverlay from "./components/ListeningOverlay";
import {
  appState, init, startPersistence, flushPersistence,
  setOverview, toggleOverview, switchWorkspaceRelative, switchWorkspaceIndex,
  activeWorkspace, activePanel, setActivePanel, reopenLastClosed,
} from "./stores/workspace";
import type { DockedPanelKind } from "./stores/workspace";
import { initTheme } from "./stores/theme";
import { initSettings, settings } from "./stores/settings";
import { applyGlobalHotkey } from "./lib/globalHotkey";
import { redock } from "./lib/detach";
import { openEditorForActivePane } from "./lib/editor";
import { dictateIntoActivePane, initVoceExitListener } from "./lib/voceClient";
import { actionForKey, appChord, isModifierKey, SWITCH_WORKSPACE_ACTIONS, type ActionId } from "./lib/keybindings";
import { initPaneControl } from "./lib/paneControl";
import { setSessionSink } from "./stores/sessions";
import { saveSession, saveTask, pruneHistory } from "./lib/sessionLogClient";
import "./App.css";

export default function App() {
  // The new-workspace launcher takes over the stage (rail + title bar persist), so it's an
  // app-level transient signal — like `zoomed`, a mode flag the stage's render-switch reads to
  // swap what fills it. Never persisted (a fresh launch every open); not in the per-workspace store.
  const [launcherOpen, setLauncherOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // The docked right-side panel (Source Control / Docs) is now per-workspace state:
  // these read the active workspace's `panel.open`, so switching workspaces shows only what was
  // open in that one. See showPanel/togglePanel below and stores/workspace.ts.
  const gitOpen = () => activePanel() === "git";
  const docsOpen = () => activePanel() === "docs";
  const fleetOpen = () => activePanel() === "fleet";
  const boardOpen = () => activePanel() === "board";
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [logPreselect, setLogPreselect] = createSignal<string | null>(null);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [reopenOpen, setReopenOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  // True when the window fills the screen (maximized or fullscreen). The .shell card is a rounded,
  // borderless, transparent-cornered window; when it fills the screen those rounded corners would
  // show the desktop through each corner. We drop the rounding/border in that state (.shell.flush).
  const [flush, setFlush] = createSignal(false);
  const win = getCurrentWindow();

  const syncWindowChrome = async () => {
    try {
      const [max, full] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
      setFlush(max || full);
    } catch { /* window API unavailable — leave rounded */ }
  };
  void syncWindowChrome();
  const unlistenResize = win.onResized(() => void syncWindowChrome());
  onCleanup(() => { void unlistenResize.then((u) => u()); });

  // Mirror the in-memory Session/Task store to the durable SQLite history (ADR-0009). Best-effort:
  // a failed write (e.g. the history DB couldn't open) must never disrupt the live store/UI.
  setSessionSink({
    session: (s) => void saveSession(s).catch(() => {}),
    task: (t) => void saveTask(t).catch(() => {}),
  });
  onCleanup(() => setSessionSink(null));

  onMount(async () => {
    await Promise.all([initTheme(), initSettings(), init()]);
    startPersistence();
    setReady(true);
    // Prune the agent-history DB to the configured bounded window (ADR-0009), once settings are
    // loaded. Best-effort: a failure (e.g. history DB unavailable) must not disrupt startup.
    void pruneHistory(settings.historyMaxAgeDays, settings.historyMaxSessions).catch(() => {});
  });

  // Listen for inter-pane control requests (the `loom` CLI → Rust relay → here). Registered in
  // the component body (not the async onMount) so onCleanup keeps its owner context.
  const unlistenCtrl = initPaneControl();
  onCleanup(() => { void unlistenCtrl.then((u) => u()); });

  // Ctrl+Shift+T from a focused pane (ADR-0005) opens the new-workspace launcher.
  const openLauncher = () => setLauncherOpen(true);
  window.addEventListener("loom:new-workspace", openLauncher);
  onCleanup(() => window.removeEventListener("loom:new-workspace", openLauncher));

  // The two right-side panels (Git / Docs) share one docked slot — only one shows at a
  // time, and toggling the open one closes it (Frameless: dock right, never replace the grid; the
  // stage just narrows and panes refit). `showPanel`/`togglePanel` keep that mutual exclusion.
  const showPanel = (which: DockedPanelKind | null) => {
    if (which !== null) setSettingsOpen(false); // opening a docked panel closes the Settings overlay
    setActivePanel(which); // per-workspace: only the active workspace's slot changes
  };
  const togglePanel = (which: DockedPanelKind) => {
    showPanel(activePanel() === which ? null : which);
  };

  // Ctrl+Shift+G from a focused pane toggles the Source Control (git diff) panel.
  const openGit = () => togglePanel("git");
  window.addEventListener("loom:source-control", openGit);
  onCleanup(() => window.removeEventListener("loom:source-control", openGit));

  // Ctrl+Shift+R from a focused pane toggles the Docs reader (mark a passage → send to a pane).
  const openDocs = () => togglePanel("docs");
  window.addEventListener("loom:docs", openDocs);
  onCleanup(() => window.removeEventListener("loom:docs", openDocs));

  // Toggles the Fleet panel — the active workspace's coordination state (blackboard + file claims).
  const openFleet = () => togglePanel("fleet");
  window.addEventListener("loom:fleet", openFleet);
  onCleanup(() => window.removeEventListener("loom:fleet", openFleet));
  const openBoard = () => togglePanel("board");
  window.addEventListener("loom:board", openBoard);
  onCleanup(() => window.removeEventListener("loom:board", openBoard));

  // Ctrl+Shift+? opens the keyboard cheat-sheet (toggle so a second press closes it).
  const openShortcuts = () => setShortcutsOpen((v) => !v);
  window.addEventListener("loom:shortcuts", openShortcuts);
  onCleanup(() => window.removeEventListener("loom:shortcuts", openShortcuts));

  // A pane's "view log" button (or the palette) opens the session-log viewer; the event may carry
  // a path to preselect that pane's log.
  const openLogs = (e: Event) => {
    setLogPreselect((e as CustomEvent).detail?.path ?? null);
    setLogsOpen(true);
  };
  window.addEventListener("loom:view-session-log", openLogs);
  onCleanup(() => window.removeEventListener("loom:view-session-log", openLogs));

  // Ctrl+Shift+, from a focused pane opens Settings — a centered overlay over the grid (like the
  // command palette). Opening it closes any docked panel.
  const openSettings = () => { showPanel(null); setSettingsOpen(true); };
  window.addEventListener("loom:settings", openSettings);
  onCleanup(() => window.removeEventListener("loom:settings", openSettings));

  // Ctrl+Shift+P opens the command palette (toggles so a second press closes it).
  const openPalette = () => setPaletteOpen((v) => !v);
  window.addEventListener("loom:command-palette", openPalette);
  onCleanup(() => window.removeEventListener("loom:command-palette", openPalette));

  // Ctrl+Shift+H opens agent History; Ctrl+Shift+Y the Reopen panel — both toggle (centered
  // overlays, like the palette). Routed from a focused pane via these events (Terminal.tsx).
  const openHistory = () => setHistoryOpen((v) => !v);
  window.addEventListener("loom:history", openHistory);
  onCleanup(() => window.removeEventListener("loom:history", openHistory));
  const openReopen = () => setReopenOpen((v) => !v);
  window.addEventListener("loom:reopen", openReopen);
  onCleanup(() => window.removeEventListener("loom:reopen", openReopen));

  // Clear a pane's "listening" chip when its voice-dictation helper (loom-voce) exits.
  onCleanup(initVoceExitListener());

  // Global fallback for the app-level Ctrl+Shift shortcuts. Terminal.tsx intercepts these via
  // xterm's key handler, but that only fires while a *terminal* owns focus — so when focus is on
  // the rail, a dialog, a button, or nothing, the shortcuts would otherwise be dead. This window
  // listener covers that gap. Pane-scoped actions (focus/split/close/zoom/copy/paste/…) need a
  // focused pane and stay terminal-only; only workspace/app actions are wired here.
  const GLOBAL_ACTIONS: Partial<Record<ActionId, () => void>> = {
    "new-workspace": () => setLauncherOpen(true),
    "reopen-closed": () => reopenLastClosed(),
    "reopen": () => setReopenOpen((v) => !v),
    "history": () => setHistoryOpen((v) => !v),
    "settings": () => openSettings(),
    "source-control": () => togglePanel("git"),
    "docs": () => togglePanel("docs"),
    "fleet": () => togglePanel("fleet"),
    "board": () => togglePanel("board"),
    "command-palette": () => setPaletteOpen((v) => !v),
    "overview": () => toggleOverview(),
    "shortcuts": () => setShortcutsOpen((v) => !v),
    "prev-workspace": () => switchWorkspaceRelative(-1),
    "next-workspace": () => switchWorkspaceRelative(1),
    "open-editor": () => void openEditorForActivePane(),
    "dictate": () => void dictateIntoActivePane(),
  };
  // Ctrl+Shift+1…9 jump straight to workspace N (works rail/dialog/nothing-focused too).
  SWITCH_WORKSPACE_ACTIONS.forEach((id, i) => {
    GLOBAL_ACTIONS[id] = () => switchWorkspaceIndex(i);
  });
  const onGlobalKey = (e: KeyboardEvent) => {
    if (!appChord(e)) return;
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
  // window waits for us; we destroy it ourselves once the final save resolves. With "close to
  // tray" on, the close button just hides the window instead (Quit from the tray still exits).
  const quitApp = async () => {
    try { await flushPersistence(); } finally {
      // Close any torn-off pane windows too, so the app actually exits (and their PTYs die with
      // the process) instead of lingering when the main window is the last to go.
      try {
        const wins = await getAllWebviewWindows();
        await Promise.all(wins.filter((w) => w.label !== win.label).map((w) => w.destroy().catch(() => {})));
      } catch (e) { console.error("closing child windows failed", e); }
      await win.destroy();
    }
  };
  const unlistenClose = win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (settings.closeToTray) { await win.hide(); return; }
    await quitApp();
  });
  onCleanup(() => { void unlistenClose.then((u) => u()); });

  // The tray's "Quit" menu item routes here so it flushes state like the close path does.
  const unlistenQuit = listen("loom://quit", () => { void quitApp(); });
  onCleanup(() => { void unlistenQuit.then((u) => u()); });

  // A torn-off pane window closing → reclaim that pane into the main grid (backs up the per-window
  // destroyed listener in lib/detach, in case that event doesn't reach us).
  const unlistenRedock = listen<{ paneId: number }>("loom://redock", (e) => {
    if (typeof e.payload?.paneId === "number") redock(e.payload.paneId);
  });
  onCleanup(() => { void unlistenRedock.then((u) => u()); });

  // Keep the global summon/hide hotkey in sync with the setting (re-registers on change; ""=off).
  createEffect(() => { void applyGlobalHotkey(settings.globalHotkey); });

  return (
    <div class="shell" classList={{ flush: flush() }}>
      <TitleBar
        onSettings={() => openSettings()}
        onGit={() => togglePanel("git")}
        onDocs={() => togglePanel("docs")}
        onFleet={() => togglePanel("fleet")}
        onBoard={() => togglePanel("board")}
        onShortcuts={() => setShortcutsOpen(true)}
        onHistory={() => setHistoryOpen((v) => !v)}
        onReopen={() => setReopenOpen((v) => !v)}
        gitOn={gitOpen}
        docsOn={docsOpen}
        fleetOn={fleetOpen}
        boardOn={boardOpen}
        settingsOn={settingsOpen}
        paletteOn={paletteOpen}
        historyOn={historyOpen}
        reopenOn={reopenOpen}
      />
      <div class="body">
      <WorkspaceRail onNew={() => setLauncherOpen(true)} />
      <div class="stage">
        {/* The launcher takes over the stage exactly as a `zoomed` pane fills it — the rail and
            title bar (outside .stage) persist. When it's open the normal workspace layers +
            FleetApprovals don't render, so the create flow gets a clean, undistracted stage. */}
        <Show
          when={launcherOpen()}
          fallback={
            <>
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
              {/* Approvals triage (Phase 3): bottom-docked, shown only when agents are blocked on you. */}
              <FleetApprovals />
            </>
          }
        >
          <NewWorkspaceLauncher onClose={() => setLauncherOpen(false)} />
        </Show>
      </div>
      {/* The right-side docked panels — flex siblings of .stage, so opening one narrows the grid
          (panes refit via their ResizeObserver) rather than covering it. Mutually exclusive.
          Suppressed while the launcher owns the stage — they belong to the backgrounded workspace. */}
      {/* Keyed on the active workspace so switching between two workspaces that *both* have a
          panel open remounts it against the new workspace (each carries its own source/state). */}
      <Show when={!launcherOpen() && gitOpen() && activeWorkspace()} keyed>
        {(_ws) => <GitPanel onClose={() => showPanel(null)} />}
      </Show>
      <Show when={!launcherOpen() && docsOpen() && activeWorkspace()} keyed>
        {(_ws) => <DocsPanel onClose={() => showPanel(null)} />}
      </Show>
      <Show when={!launcherOpen() && fleetOpen() && activeWorkspace()} keyed>
        {(_ws) => <FleetPanel onClose={() => showPanel(null)} />}
      </Show>
      <Show when={!launcherOpen() && boardOpen() && activeWorkspace()} keyed>
        {(_ws) => <BoardPanel onClose={() => showPanel(null)} />}
      </Show>
      </div>
      <Show when={settingsOpen()}>
        <Settings onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={shortcutsOpen()}>
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      </Show>
      <Show when={logsOpen()}>
        <SessionLogViewer preselectPath={logPreselect()} onClose={() => setLogsOpen(false)} />
      </Show>
      <Show when={historyOpen()}>
        <HistorySearch onClose={() => setHistoryOpen(false)} />
      </Show>
      <Show when={reopenOpen()}>
        <ReopenPanel onClose={() => setReopenOpen(false)} />
      </Show>
      <Show when={paletteOpen()}>
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNewWorkspace={() => setLauncherOpen(true)}
          onSettings={() => openSettings()}
          onGit={() => showPanel("git")}
          onDocs={() => showPanel("docs")}
          onFleet={() => showPanel("fleet")}
          onBoard={() => showPanel("board")}
          onShortcuts={() => setShortcutsOpen(true)}
          onLogs={() => { setLogPreselect(null); setLogsOpen(true); }}
          onHistory={() => setHistoryOpen(true)}
          onReopen={() => setReopenOpen(true)}
        />
      </Show>
      {/* Voice-dictation "you're talking" popup — floats over everything while a pane is listening. */}
      <ListeningOverlay />
    </div>
  );
}

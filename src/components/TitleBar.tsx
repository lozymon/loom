// VSCode-style custom title bar. Replaces the native window frame (decorations:false in
// tauri.conf.json), so this bar owns: the app icon + name, a flat row of app-action buttons,
// a draggable region (data-tauri-drag-region), and the min/maximize/close window controls.
//
// Actions reuse the same entry points as the rail/keyboard: New/Settings/Git are passed down
// from App; Overview and the Command Palette fire through the store / the window events App
// already listens for; Broadcast focuses the always-docked broadcast input.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { appState, toggleOverview, saveCurrentAsPreset } from "../stores/workspace";
import appIcon from "../assets/app-icon.png";

export default function TitleBar(props: {
  onNew: () => void;
  onSettings: () => void;
  onGit: () => void;
}) {
  const win = getCurrentWindow();
  const openPalette = () => window.dispatchEvent(new CustomEvent("termhaus:command-palette"));
  const focusBroadcast = () => window.dispatchEvent(new CustomEvent("termhaus:focus-broadcast"));

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-brand" data-tauri-drag-region>
        <img class="tb-logo" src={appIcon} alt="" width="18" height="18" />
        <span class="tb-name">Termhaus</span>
      </div>

      <nav class="tb-actions">
        <button class="tb-btn" title="New workspace (Ctrl+Shift+T)" onClick={() => props.onNew()}>
          ＋ New
        </button>
        <button
          class="tb-btn"
          classList={{ on: appState.overview }}
          title="Overview / fleet glance (Ctrl+Shift+O)"
          onClick={() => toggleOverview()}
        >
          ▦ Overview
        </button>
        <button class="tb-btn" title="Focus the broadcast input" onClick={focusBroadcast}>
          ⌁ Broadcast
        </button>
        <button class="tb-btn" title="Save active workspace as a preset" onClick={() => saveCurrentAsPreset()}>
          ⛁ Save
        </button>
        <button class="tb-btn" title="Command palette (Ctrl+Shift+P)" onClick={openPalette}>
          ⌘ Palette
        </button>
        <button class="tb-btn" title="Source control (Ctrl+Shift+G)" onClick={() => props.onGit()}>
          ⎇ Git
        </button>
        <button class="tb-btn" title="Settings" onClick={() => props.onSettings()}>
          ⚙ Settings
        </button>
      </nav>

      <div class="tb-spacer" data-tauri-drag-region />

      <div class="tb-window">
        <button class="tb-wbtn" title="Minimize" onClick={() => void win.minimize()}>﹣</button>
        <button class="tb-wbtn" title="Maximize" onClick={() => void win.toggleMaximize()}>▢</button>
        <button class="tb-wbtn close" title="Close" onClick={() => void win.close()}>✕</button>
      </div>
    </header>
  );
}

// VSCode-style custom title bar. Replaces the native window frame (decorations:false in
// tauri.conf.json), so this bar owns: the app icon + name, a flat row of app-action buttons,
// a draggable region (data-tauri-drag-region), and the min/maximize/close window controls.
//
// Actions reuse the same entry points as the rail/keyboard: Settings/Git are passed down from
// App; Overview and the Command Palette fire through the store / the window events App already
// listens for. (New workspace lives in the rail header; broadcasting in the docked bar;
// save-as-preset in the palette — none need a button here.)

import { getCurrentWindow } from "@tauri-apps/api/window";
import { appState, toggleOverview } from "../stores/workspace";
import appIcon from "../assets/app-icon.png";

export default function TitleBar(props: {
  onSettings: () => void;
  onGit: () => void;
}) {
  const win = getCurrentWindow();
  const openPalette = () => window.dispatchEvent(new CustomEvent("termhaus:command-palette"));

  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-brand" data-tauri-drag-region>
        <img class="tb-logo" src={appIcon} alt="" width="18" height="18" />
        <span class="tb-name">Termhaus</span>
      </div>

      <nav class="tb-actions">
        <button
          class="tb-btn"
          classList={{ on: appState.overview }}
          title="Overview / fleet glance (Ctrl+Shift+O)"
          onClick={() => toggleOverview()}
        >
          ▦ Overview
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

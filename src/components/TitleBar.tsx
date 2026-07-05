// VSCode-style custom title bar. Replaces the native window frame (decorations:false in
// tauri.conf.json), so this bar owns: the app icon + name on the left, a draggable region
// (data-tauri-drag-region), a right-aligned row of icon app-action buttons, and the
// (enlarged) min/maximize/close window controls — separated from the actions by a divider.
//
// Actions reuse the same entry points as the rail/keyboard: Settings/Git are passed down from
// App; Overview and the Command Palette fire through the store / the window events App already
// listens for. (New workspace lives in the rail header; save-as-preset in the palette — none
// need a button here.) Each action is icon-only; the tooltip (title) carries the label.

import { Show } from 'solid-js';
import { MOD_NAMESPACE } from '../lib/keybindings';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appState, toggleOverview, setOverview } from '../stores/workspace';
import { settings } from '../stores/settings';
import loomMark from '../assets/loom-mark.svg';

// Line-style 16px icons (stroke = currentColor) so they inherit the button's text color and
// the active/hover states. Trusted static markup → innerHTML is safe here.
const ICONS: Record<string, string> = {
  overview:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  palette:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M4.5 6.8l2 1.7-2 1.7"/><path d="M8.4 10.2h3"/></svg>',
  git:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.6" r="1.7"/><circle cx="4.5" cy="12.4" r="1.7"/><circle cx="11.5" cy="5.4" r="1.7"/><path d="M4.5 5.3v5.4"/><path d="M11.5 7.1c0 2.3-2.4 2.8-4.6 3.4"/></svg>',
  docs:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2v3h3"/><path d="M6 8.2h4M6 10.6h4"/></svg>',
  fleet:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="1.7"/><circle cx="3" cy="3.4" r="1.4"/><circle cx="13" cy="3.4" r="1.4"/><circle cx="8" cy="13.4" r="1.4"/><path d="M6.8 6.8 4.1 4.3M9.2 6.8 11.9 4.3M8 9.7v2.3"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.5"/></svg>',
  reopen:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8a4.9 4.9 0 1 1 1.1 3.1"/><path d="M3.2 4.6v3.2h3.2"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.2h5.2M11 5.2h3M2 10.8h3M9.8 10.8h4.2"/><circle cx="9.2" cy="5.2" r="1.9"/><circle cx="6.8" cy="10.8" r="1.9"/></svg>',
  shortcuts:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="4" width="12.8" height="8" rx="1.6"/><path d="M4 6.6h0M6.5 6.6h0M9 6.6h0M11.5 6.6h0M4 9.2h0M11.5 9.2h0"/><path d="M6 9.4h4"/></svg>',
  min: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  max: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

export default function TitleBar(props: {
  onSettings: () => void;
  onGit: () => void;
  onDocs: () => void;
  onFleet: () => void;
  onShortcuts: () => void;
  onHistory: () => void;
  onReopen: () => void;
  gitOn: () => boolean;
  docsOn: () => boolean;
  fleetOn: () => boolean;
  settingsOn: () => boolean;
  paletteOn: () => boolean;
  historyOn: () => boolean;
  reopenOn: () => boolean;
}) {
  const win = getCurrentWindow();
  const openPalette = () =>
    window.dispatchEvent(new CustomEvent('loom:command-palette'));

  return (
    <header class="titlebar" data-tauri-drag-region>
      <button class="tb-brand" title="Overview" onClick={() => setOverview(false)}>
        <img class="tb-logo" src={loomMark} alt="" width="18" height="18" />
        <span class="tb-name">Loom</span>
      </button>

      <div class="tb-spacer" data-tauri-drag-region />

      <nav class="tb-actions">
        <Show when={settings.navVisible.overview}>
          <button
            class="tb-icon"
            classList={{ on: appState.overview }}
            title={`Overview / fleet glance (${MOD_NAMESPACE}+O)`}
            onClick={() => toggleOverview()}
            innerHTML={ICONS.overview}
          />
        </Show>
        <Show when={settings.navVisible.palette}>
          <button
            class="tb-icon"
            classList={{ on: props.paletteOn() }}
            title={`Command palette (${MOD_NAMESPACE}+P)`}
            onClick={openPalette}
            innerHTML={ICONS.palette}
          />
        </Show>
        <Show when={settings.navVisible.git}>
          <button
            class="tb-icon"
            classList={{ on: props.gitOn() }}
            title={`Source control (${MOD_NAMESPACE}+G)`}
            onClick={() => props.onGit()}
            innerHTML={ICONS.git}
          />
        </Show>
        <Show when={settings.navVisible.docs}>
          <button
            class="tb-icon"
            classList={{ on: props.docsOn() }}
            title={`Docs reader — mark a passage → send to a pane (${MOD_NAMESPACE}+R)`}
            onClick={() => props.onDocs()}
            innerHTML={ICONS.docs}
          />
        </Show>
        <Show when={settings.navVisible.fleet}>
          <button
            class="tb-icon"
            classList={{ on: props.fleetOn() }}
            title={`Fleet panel — the workspace's blackboard & file claims (${MOD_NAMESPACE}+K)`}
            onClick={() => props.onFleet()}
            innerHTML={ICONS.fleet}
          />
        </Show>
        <Show when={settings.navVisible.history}>
          <button
            class="tb-icon"
            classList={{ on: props.historyOn() }}
            title={`Search agent history — past sessions & tasks (${MOD_NAMESPACE}+H)`}
            onClick={() => props.onHistory()}
            innerHTML={ICONS.history}
          />
        </Show>
        <Show when={settings.navVisible.reopen}>
          <button
            class="tb-icon"
            classList={{ on: props.reopenOn() }}
            title={`Reopen a closed pane/workspace, or resume any Claude session (${MOD_NAMESPACE}+Y)`}
            onClick={() => props.onReopen()}
            innerHTML={ICONS.reopen}
          />
        </Show>
        <button
          class="tb-icon"
          classList={{ on: props.settingsOn() }}
          title="Settings"
          onClick={() => props.onSettings()}
          innerHTML={ICONS.settings}
        />
        <button
          class="tb-icon"
          title={`Keyboard shortcuts (${MOD_NAMESPACE}+?)`}
          onClick={() => props.onShortcuts()}
          innerHTML={ICONS.shortcuts}
        />
      </nav>

      <div class="tb-sep" />

      <div class="tb-window">
        <button
          class="tb-wbtn"
          title="Minimize"
          onClick={() => void win.minimize()}
          innerHTML={ICONS.min}
        />
        <button
          class="tb-wbtn"
          title="Maximize"
          onClick={() => void win.toggleMaximize()}
          innerHTML={ICONS.max}
        />
        <button
          class="tb-wbtn close"
          title="Close"
          onClick={() => void win.close()}
          innerHTML={ICONS.close}
        />
      </div>
    </header>
  );
}

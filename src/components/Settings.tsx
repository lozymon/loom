// The Settings page (a modal over the stage), opened from the ⚙ button on the rail. It is
// the single home for app preferences: the theme picker (moved here from the rail) plus the
// `settings` store fields. Every control writes straight to its store, which persists and —
// for terminal-shaping fields — restyles open panes live, so there is no Save/Apply step.

import { For, onCleanup, onMount } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { themes, themeId, setTheme } from "../stores/theme";
import { settings, setSetting, resetSettings, type CursorStyle } from "../stores/settings";

const CURSORS: CursorStyle[] = ["block", "bar", "underline"];

export default function Settings(props: { onClose: () => void }) {
  // Esc closes the modal from anywhere (the panel itself isn't focus-trapped).
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  async function browseDefaultCwd() {
    const picked = await open({ directory: true, title: "Default working folder" });
    if (typeof picked === "string") setSetting("defaultCwd", picked);
  }

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <div class="settings" onClick={(e) => e.stopPropagation()}>
        <header class="settings-head">
          <span class="settings-title">⚙ Settings</span>
          <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
        </header>

        <div class="settings-body">
          {/* ---- Theme ---- */}
          <section class="settings-section">
            <h3>Theme</h3>
            <div class="settings-themes">
              <For each={themes}>
                {(t) => (
                  <button
                    class="theme-card"
                    classList={{ on: t.id === themeId() }}
                    onClick={() => setTheme(t.id)}
                    title={t.name}
                  >
                    <span
                      class="theme-swatch"
                      style={{ background: t.terminal.background, color: t.terminal.foreground }}
                    >
                      <span style={{ color: t.terminal.cursor }}>▏</span>Ab
                    </span>
                    <span class="theme-card-name">{t.name}</span>
                  </button>
                )}
              </For>
            </div>
          </section>

          {/* ---- Appearance ---- */}
          <section class="settings-section">
            <h3>Appearance</h3>
            <label class="settings-row">
              <span class="settings-label">Font family</span>
              <input
                class="settings-input"
                value={settings.fontFamily}
                onChange={(e) => setSetting("fontFamily", e.currentTarget.value.trim() || settings.fontFamily)}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">Font size</span>
              <span class="settings-range">
                <input
                  type="range"
                  min="9"
                  max="24"
                  value={settings.fontSize}
                  onInput={(e) => setSetting("fontSize", e.currentTarget.valueAsNumber)}
                />
                <span class="settings-val">{settings.fontSize}px</span>
              </span>
            </label>
            <label class="settings-row">
              <span class="settings-label">Cursor style</span>
              <select
                class="settings-select"
                value={settings.cursorStyle}
                onChange={(e) => setSetting("cursorStyle", e.currentTarget.value as CursorStyle)}
              >
                <For each={CURSORS}>{(c) => <option value={c}>{c}</option>}</For>
              </select>
            </label>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.cursorBlink}
                onChange={(e) => setSetting("cursorBlink", e.currentTarget.checked)}
              />
              <span class="settings-label">Blink the cursor</span>
            </label>
            <label class="settings-row">
              <span class="settings-label">Scrollback lines</span>
              <input
                class="settings-input narrow"
                type="number"
                min="0"
                max="100000"
                step="500"
                value={settings.scrollback}
                onChange={(e) => setSetting("scrollback", Math.max(0, e.currentTarget.valueAsNumber || 0))}
              />
            </label>
          </section>

          {/* ---- Terminal behaviour ---- */}
          <section class="settings-section">
            <h3>Terminal behaviour</h3>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.copyOnSelect}
                onChange={(e) => setSetting("copyOnSelect", e.currentTarget.checked)}
              />
              <span class="settings-label">Copy on select <span class="muted">— selecting text copies it to the clipboard</span></span>
            </label>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.middleClickPaste}
                onChange={(e) => setSetting("middleClickPaste", e.currentTarget.checked)}
              />
              <span class="settings-label">Middle-click paste</span>
            </label>
          </section>

          {/* ---- New terminals ---- */}
          <section class="settings-section">
            <h3>New terminals</h3>
            <label class="settings-row">
              <span class="settings-label">Default shell</span>
              <input
                class="settings-input"
                placeholder="$SHELL (e.g. /usr/bin/fish)"
                value={settings.defaultShell}
                onChange={(e) => setSetting("defaultShell", e.currentTarget.value.trim())}
              />
            </label>
            <label class="settings-row">
              <span class="settings-label">Default folder</span>
              <span class="settings-range">
                <input
                  class="settings-input"
                  placeholder="$HOME"
                  value={settings.defaultCwd}
                  onChange={(e) => setSetting("defaultCwd", e.currentTarget.value.trim())}
                />
                <button class="settings-btn" onClick={browseDefaultCwd}>Browse…</button>
              </span>
            </label>
            <p class="settings-hint muted">Applies to terminals you open from now on.</p>
          </section>

          {/* ---- Safety + Broadcast ---- */}
          <section class="settings-section">
            <h3>Behaviour</h3>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.confirmClose}
                onChange={(e) => setSetting("confirmClose", e.currentTarget.checked)}
              />
              <span class="settings-label">Confirm before closing a running terminal</span>
            </label>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.broadcastNewline}
                onChange={(e) => setSetting("broadcastNewline", e.currentTarget.checked)}
              />
              <span class="settings-label">Broadcast presses Enter <span class="muted">— append a newline so the message runs</span></span>
            </label>
          </section>
        </div>

        <footer class="settings-foot">
          <button class="settings-btn" onClick={() => resetSettings()}>Reset to defaults</button>
          <span class="spacer" />
          <button class="settings-btn primary" onClick={() => props.onClose()}>Done</button>
        </footer>
      </div>
    </div>
  );
}

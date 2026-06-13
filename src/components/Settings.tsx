// The Settings page (a modal over the stage), opened from the ⚙ button on the rail. It is
// the single home for app preferences: the theme picker (moved here from the rail) plus the
// `settings` store fields. Every control writes straight to its store, which persists and —
// for terminal-shaping fields — restyles open panes live, so there is no Save/Apply step.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { themes, themeId, setTheme } from "../stores/theme";
import {
  settings,
  setSetting,
  resetSettings,
  setKeybinding,
  resetKeybinding,
  resetKeybindings,
  type CursorStyle,
} from "../stores/settings";
import { ACTIONS, formatBinding, isModifierKey, type ActionId } from "../lib/keybindings";

const CURSORS: CursorStyle[] = ["block", "bar", "underline"];

type TabId = "appearance" | "terminal" | "keys";
const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "keys", label: "Key bindings" },
];

// Actions grouped (in declaration order) for the keybinding list's subheadings.
const KB_GROUPS = [...new Set(ACTIONS.map((a) => a.group))].map((name) => ({
  name,
  actions: ACTIONS.filter((a) => a.group === name),
}));

export default function Settings(props: { onClose: () => void }) {
  const [tab, setTab] = createSignal<TabId>("appearance");
  // The action currently waiting for a new key combo (null = not capturing).
  const [capturing, setCapturing] = createSignal<ActionId | null>(null);

  // Esc closes the modal from anywhere (the panel itself isn't focus-trapped) — but not
  // while capturing a shortcut, where the capture handler swallows Esc to cancel instead.
  // Capture phase: while a terminal has focus, xterm stops propagation of Escape (it sends
  // \x1b to the PTY), so a bubble-phase window listener wouldn't fire until you click off the
  // pane. The capture handler below (onCapture) runs first and short-circuits while binding.
  const onKey = (e: KeyboardEvent) => {
    if (capturing()) return;
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // While capturing, grab the next Ctrl+Shift+<key> combo and rebind. Runs in the capture
  // phase + stops propagation so it pre-empts the modal's Esc-to-close and any pane handler.
  const onCapture = (e: KeyboardEvent) => {
    const action = capturing();
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setCapturing(null); return; }
    if (isModifierKey(e.key)) return; // wait for a real key
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return; // must stay in the namespace
    setKeybinding(action, e.key);
    setCapturing(null);
  };
  onMount(() => window.addEventListener("keydown", onCapture, true));
  onCleanup(() => window.removeEventListener("keydown", onCapture, true));

  // Actions whose key collides with another action's — flagged so the user can fix them.
  const conflicts = createMemo(() => {
    const byKey = new Map<string, ActionId[]>();
    for (const a of ACTIONS) {
      const k = settings.keybindings[a.id];
      byKey.set(k, [...(byKey.get(k) ?? []), a.id]);
    }
    const out = new Set<ActionId>();
    for (const ids of byKey.values()) if (ids.length > 1) ids.forEach((id) => out.add(id));
    return out;
  });

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

        <nav class="settings-tabs">
          <For each={TABS}>
            {(t) => (
              <button
                class="settings-tab"
                classList={{ on: tab() === t.id }}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </nav>

        <div class="settings-body">
          <Show when={tab() === "appearance"}>
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
          </Show>

          <Show when={tab() === "terminal"}>
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
                checked={settings.confirmExternalSpawn}
                onChange={(e) => setSetting("confirmExternalSpawn", e.currentTarget.checked)}
              />
              <span class="settings-label">Confirm before another pane spawns a terminal <span class="muted">— the `th spawn` control bus</span></span>
            </label>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.broadcastNewline}
                onChange={(e) => setSetting("broadcastNewline", e.currentTarget.checked)}
              />
              <span class="settings-label">Broadcast presses Enter <span class="muted">— append a newline so the message runs</span></span>
            </label>
            <label class="settings-row">
              <span class="settings-label">Broadcast stagger <span class="muted">— delay between panes (0 = all at once)</span></span>
              <span class="settings-range">
                <input
                  class="settings-input narrow"
                  type="number"
                  min="0"
                  max="10000"
                  step="50"
                  value={settings.broadcastStaggerMs}
                  onChange={(e) => setSetting("broadcastStaggerMs", Math.max(0, e.currentTarget.valueAsNumber || 0))}
                />
                <span class="settings-val">ms</span>
              </span>
            </label>
          </section>

          {/* ---- Notifications ---- */}
          <section class="settings-section">
            <h3>Notifications</h3>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.notifyOnAttention}
                onChange={(e) => setSetting("notifyOnAttention", e.currentTarget.checked)}
              />
              <span class="settings-label">Notify when a pane needs you <span class="muted">— desktop notification when a command finishes (or an agent calls <code>th attention</code>) while Termhaus is in the background</span></span>
            </label>
            <p class="settings-hint muted">Only fires when the Termhaus window isn't focused — when it's up front the amber pane border is enough. Your OS may ask permission the first time.</p>
          </section>

          {/* ---- Window & tray ---- */}
          <section class="settings-section">
            <h3>Window &amp; tray</h3>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.closeToTray}
                onChange={(e) => setSetting("closeToTray", e.currentTarget.checked)}
              />
              <span class="settings-label">Close to tray <span class="muted">— the window's close button hides Termhaus instead of quitting (Quit from the tray menu still exits)</span></span>
            </label>
            <label class="settings-row">
              <span class="settings-label">Global summon hotkey</span>
              <input
                class="settings-input"
                value={settings.globalHotkey}
                placeholder="e.g. CommandOrControl+Alt+Backquote"
                spellcheck={false}
                onChange={(e) => setSetting("globalHotkey", e.currentTarget.value.trim())}
              />
            </label>
            <p class="settings-hint muted">Summons or hides the window from anywhere. A Tauri accelerator — modifiers <code>CommandOrControl</code>/<code>Alt</code>/<code>Shift</code>/<code>Super</code> joined with <code>+</code> (e.g. <code>Alt+Space</code>). Leave empty to disable. The tray icon (left-click) does the same.</p>
          </section>

          {/* ---- Session logging ---- */}
          <section class="settings-section">
            <h3>Session logging</h3>
            <label class="settings-row toggle">
              <input
                type="checkbox"
                checked={settings.sessionLogging}
                onChange={(e) => setSetting("sessionLogging", e.currentTarget.checked)}
              />
              <span class="settings-label">Log pane output to disk <span class="muted">— append each pane's raw output under the app's logs/ folder</span></span>
            </label>
            <p class="settings-hint muted">Applies to terminals you open from now on. Useful for reviewing what a fleet of agents did; files can grow large.</p>
          </section>
          </Show>

          <Show when={tab() === "keys"}>
          {/* ---- Key bindings ---- */}
          <section class="settings-section">
            <div class="settings-row">
              <p class="settings-hint muted" style={{ margin: "0", flex: "1 1 auto" }}>
                Every app shortcut lives in the Ctrl+Shift namespace so plain keys still reach the
                terminal. Click a shortcut, then press the new Ctrl+Shift combination (Esc cancels).
              </p>
              <button class="settings-btn" onClick={() => { setCapturing(null); resetKeybindings(); }}>
                Reset shortcuts
              </button>
            </div>
            <For each={KB_GROUPS}>
              {(group) => (
                <>
                  <h4 class="kb-group">{group.name}</h4>
                  <For each={group.actions}>
                    {(a) => {
                      const isDefault = () =>
                        settings.keybindings[a.id] === a.defaultKey;
                      return (
                        <div class="settings-row">
                          <span class="settings-label">{a.label}</span>
                          <button
                            class="kb-key"
                            classList={{
                              capturing: capturing() === a.id,
                              conflict: conflicts().has(a.id),
                            }}
                            title={conflicts().has(a.id) ? "Conflicts with another shortcut" : "Click to rebind"}
                            onClick={() => setCapturing(capturing() === a.id ? null : a.id)}
                          >
                            {capturing() === a.id ? "press keys…" : formatBinding(settings.keybindings[a.id])}
                          </button>
                          <button
                            class="kb-reset"
                            title="Reset to default"
                            disabled={isDefault()}
                            onClick={() => resetKeybinding(a.id)}
                          >
                            ⟳
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </section>
          </Show>
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

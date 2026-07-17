// The Settings page (a centered overlay over the grid, like the command palette), opened from
// the ⚙ button on the rail or Ctrl+Shift+,. It is
// the single home for app preferences: the theme picker (moved here from the rail) plus the
// `settings` store fields. Every control writes straight to its store, which persists and —
// for terminal-shaping fields — restyles open panes live, so there is no Save/Apply step.

import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import RemoteSettings from "./RemoteSettings";
import { getVersion } from "@tauri-apps/api/app";
import { themes, themeId, setTheme } from "../stores/theme";
import {
  settings,
  setSetting,
  setNavVisible,
  resetSettings,
  setKeybinding,
  resetKeybinding,
  resetKeybindings,
  VOICE_LANGUAGES,
  type CursorStyle,
  type NavItemId,
} from "../stores/settings";
import { ACTIONS, appChord, formatBinding, isModifierKey, MOD_NAMESPACE, type ActionId } from "../lib/keybindings";

const CURSORS: CursorStyle[] = ["block", "bar", "underline"];

// Top-bar nav items that can be shown/hidden (Settings is always shown, so it's not listed).
const NAV_ITEMS: { id: NavItemId; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "fleet glance" },
  { id: "palette", label: "Palette", hint: "command palette" },
  { id: "git", label: "Git", hint: "source control" },
  { id: "docs", label: "Docs", hint: "markdown reader" },
  { id: "fleet", label: "Fleet", hint: "blackboard & file claims" },
  { id: "board", label: "Board", hint: "task board" },
  { id: "history", label: "History", hint: "agent session search" },
  { id: "reopen", label: "Reopen", hint: "closed panes & Claude sessions" },
];

type TabId = "appearance" | "terminal" | "remote" | "keys";
const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "remote", label: "Remote" },
  { id: "keys", label: "Key bindings" },
];

/** A label + pill-toggle row for a boolean setting (used across the grouped settings cards). */
function ToggleRow(p: { label: JSX.Element; checked: boolean; onToggle: () => void }) {
  return (
    <div class="settings-row">
      <span class="settings-label">{p.label}</span>
      <button
        class="settings-toggle"
        classList={{ on: p.checked }}
        title={p.checked ? "On" : "Off"}
        onClick={p.onToggle}
      >
        <span class="settings-toggle-knob" />
      </button>
    </div>
  );
}

// Actions grouped (in declaration order) for the keybinding list's subheadings.
const KB_GROUPS = [...new Set(ACTIONS.map((a) => a.group))].map((name) => ({
  name,
  actions: ACTIONS.filter((a) => a.group === name),
}));

export default function Settings(props: { onClose: () => void }) {
  const [tab, setTab] = createSignal<TabId>("appearance");
  // The action currently waiting for a new key combo (null = not capturing).
  const [capturing, setCapturing] = createSignal<ActionId | null>(null);
  // App version, read live from Tauri so it always reflects the running build.
  const [version, setVersion] = createSignal("");
  onMount(() => { getVersion().then(setVersion).catch(() => {}); });

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
    if (!appChord(e)) return; // must stay in the namespace (Ctrl+Shift, or Cmd+Shift on macOS)
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
    <div class="settings-overlay" onPointerDown={() => props.onClose()}>
      <div class="settings" onPointerDown={(e) => e.stopPropagation()}>
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
            <p class="settings-sub">Click a theme to apply it live across the app.</p>
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
                      Ab
                      <span class="theme-dot" style={{ background: t.terminal.cursor }} />
                    </span>
                    <span class="theme-card-name">{t.name}</span>
                  </button>
                )}
              </For>
            </div>
          </section>

          {/* ---- Terminal ---- */}
          <section class="settings-section">
            <h3>Terminal</h3>
            <div class="settings-card">
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
            <div class="settings-row">
              <span class="settings-label">Cursor style</span>
              <div class="settings-seg">
                <For each={CURSORS}>
                  {(c) => (
                    <button
                      class="settings-seg-opt"
                      classList={{ on: settings.cursorStyle === c }}
                      onClick={() => setSetting("cursorStyle", c)}
                    >
                      {c[0].toUpperCase() + c.slice(1)}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="settings-row">
              <span class="settings-label">Cursor blink</span>
              <button
                class="settings-toggle"
                classList={{ on: settings.cursorBlink }}
                title={settings.cursorBlink ? "On" : "Off"}
                onClick={() => setSetting("cursorBlink", !settings.cursorBlink)}
              >
                <span class="settings-toggle-knob" />
              </button>
            </div>
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
            </div>
          </section>

          {/* ---- Top bar (show/hide nav items) ---- */}
          <section class="settings-section">
            <h3>Top bar</h3>
            <p class="settings-sub">Show or hide items in the top menu. Settings stays visible, and every
              item is still reachable by its shortcut.</p>
            <div class="settings-card">
              <For each={NAV_ITEMS}>
                {(item) => (
                  <div class="settings-row">
                    <span class="settings-label">{item.label} <span class="muted">— {item.hint}</span></span>
                    <button
                      class="settings-toggle"
                      classList={{ on: settings.navVisible[item.id] }}
                      title={settings.navVisible[item.id] ? "Shown" : "Hidden"}
                      onClick={() => setNavVisible(item.id, !settings.navVisible[item.id])}
                    >
                      <span class="settings-toggle-knob" />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </section>
          </Show>

          <Show when={tab() === "terminal"}>
          {/* ---- Terminal behaviour ---- */}
          <section class="settings-section">
            <h3>Terminal behaviour</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Copy on select <span class="muted">— selecting text copies it to the clipboard</span></>}
                checked={settings.copyOnSelect}
                onToggle={() => setSetting("copyOnSelect", !settings.copyOnSelect)}
              />
              <ToggleRow
                label="Middle-click paste"
                checked={settings.middleClickPaste}
                onToggle={() => setSetting("middleClickPaste", !settings.middleClickPaste)}
              />
            </div>
          </section>

          {/* ---- New terminals ---- */}
          <section class="settings-section">
            <h3>New terminals</h3>
            <div class="settings-card">
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
                <span class="settings-control">
                  <input
                    class="settings-input"
                    placeholder="$HOME"
                    value={settings.defaultCwd}
                    onChange={(e) => setSetting("defaultCwd", e.currentTarget.value.trim())}
                  />
                  <button class="settings-btn" onClick={browseDefaultCwd}>Browse…</button>
                </span>
              </label>
            </div>
            <p class="settings-hint muted">Applies to terminals you open from now on.</p>
          </section>

          {/* ---- External editor ---- */}
          <section class="settings-section">
            <h3>External editor</h3>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-label">Editor command</span>
                <input
                  class="settings-input"
                  placeholder="e.g. code, subl, zed"
                  value={settings.editorCommand}
                  onChange={(e) => setSetting("editorCommand", e.currentTarget.value.trim())}
                />
              </label>
            </div>
            <p class="settings-hint muted">
              The <b>✎</b> button in each pane's controls (or <code>{formatBinding(settings.keybindings["open-editor"])}</code>, rebindable
              under Key bindings) runs this on the pane's working folder. The folder is appended as
              the last argument, or substituted for <code>{"{dir}"}</code> if you include it (e.g.
              <code>code -n {"{dir}"}</code>). Leave empty to hide the button.
            </p>
          </section>

          {/* ---- Voice dictation ---- */}
          <section class="settings-section">
            <h3>Voice dictation</h3>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-label">Whisper model</span>
                <select
                  class="settings-select"
                  value={settings.voiceModel}
                  onChange={(e) => setSetting("voiceModel", e.currentTarget.value)}
                >
                  <option value="base.en">base.en — English only, fastest</option>
                  <option value="base-q5_1">base (q5_1) — multilingual, very fast</option>
                  <option value="small-q5_1">small (q5_1) — multilingual, fast (recommended)</option>
                  <option value="small">small — multilingual</option>
                  <option value="medium-q5_0">medium (q5_0) — accurate, faster than medium</option>
                  <option value="medium">medium — multilingual, most accurate on CPU</option>
                  <option value="large-v3">large-v3 — multilingual, best (slow on CPU)</option>
                </select>
              </label>
              <label class="settings-row">
                <span class="settings-label">Language</span>
                <select
                  class="settings-select"
                  value={settings.voiceLanguage}
                  onChange={(e) => setSetting("voiceLanguage", e.currentTarget.value)}
                >
                  <For each={VOICE_LANGUAGES}>
                    {(l) => (
                      <option value={l.code}>
                        {l.code === "" ? "Auto-detect (mix languages freely)" : l.label}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </div>
            <p class="settings-hint muted">
              Used by the dictation hotkey (<code>{formatBinding(settings.keybindings["dictate"])}</code>).
              The multilingual models (<b>small</b>/<b>medium</b>/<b>large-v3</b>) auto-detect the
              spoken language per phrase — pick one of these if you dictate in more than one language.
              Set <b>Language</b> to pin a single language when auto-detect keeps misreading short
              clips; leave it on <b>Auto-detect</b> if you actually mix languages in a session
              (pinning applies to every phrase, and needs a multilingual model). The chosen model
              downloads on first use.
            </p>
            <p class="settings-hint muted">
              The <b>q5_1</b>/<b>q5_0</b> entries are quantized — about half the size and noticeably
              faster on CPU, with only a small accuracy cost. <b>small (q5_1)</b> is the best
              speed/quality balance for dictation. Bigger models are slower per phrase; if that's the
              bottleneck, a GPU build is the real fix.
            </p>
          </section>

          {/* ---- Safety ---- */}
          <section class="settings-section">
            <h3>Safety</h3>
            <div class="settings-card">
              <ToggleRow
                label="Confirm before closing a running terminal"
                checked={settings.confirmClose}
                onToggle={() => setSetting("confirmClose", !settings.confirmClose)}
              />
              <ToggleRow
                label={<>Confirm before another pane spawns a terminal <span class="muted">— the <code>loom spawn</code> control bus</span></>}
                checked={settings.confirmExternalSpawn}
                onToggle={() => setSetting("confirmExternalSpawn", !settings.confirmExternalSpawn)}
              />
              <ToggleRow
                label={<>Confirm a destructive broadcast <span class="muted">— warn before <code>loom broadcast</code> fans <code>git reset --hard</code>, <code>rm -rf</code>, a force-push … to many panes</span></>}
                checked={settings.confirmDestructiveBroadcast}
                onToggle={() => setSetting("confirmDestructiveBroadcast", !settings.confirmDestructiveBroadcast)}
              />
              <ToggleRow
                label={<>Honor per-pane input holds <span class="muted">— require an OK before <code>loom send</code>/<code>broadcast</code> reaches a gated pane (<code>loom gate &lt;pane&gt;</code>)</span></>}
                checked={settings.honorInputHolds}
                onToggle={() => setSetting("honorInputHolds", !settings.honorInputHolds)}
              />
            </div>
          </section>

          {/* ---- Notifications ---- */}
          <section class="settings-section">
            <h3>Notifications</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Notify when a pane needs you <span class="muted">— desktop notification when a command finishes (or an agent calls <code>loom attention</code>) while Loom is in the background</span></>}
                checked={settings.notifyOnAttention}
                onToggle={() => setSetting("notifyOnAttention", !settings.notifyOnAttention)}
              />
            </div>
            <p class="settings-hint muted">Only fires when the Loom window isn't focused — when it's up front the amber pane border is enough. Your OS may ask permission the first time.</p>
          </section>

          {/* ---- Fleet observability ---- */}
          <section class="settings-section">
            <h3>Idle agent detection</h3>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-label">Flag a silent agent after <span class="muted">— seconds (0 = off)</span></span>
                <input
                  class="settings-input narrow"
                  type="number"
                  min="0"
                  max="3600"
                  step="5"
                  value={settings.idleStuckSeconds}
                  onChange={(e) => setSetting("idleStuckSeconds", Math.max(0, Math.floor(e.currentTarget.valueAsNumber || 0)))}
                />
              </label>
              <ToggleRow
                label={<>Heuristic "waiting on you" floor for hookless agents <span class="muted">— for agents that don't self-report (Codex, Aider, Gemini…), guess when one is waiting by reading a prompt-shaped last line that then goes quiet</span></>}
                checked={settings.heuristicStatus}
                onToggle={() => setSetting("heuristicStatus", !settings.heuristicStatus)}
              />
            </div>
            <p class="settings-hint muted">An agent pane that's busy but has printed nothing for this long is likely waiting on a prompt — it joins the amber "needs you" count. Uses byte-flow timing only, never the pane's output.</p>
            <p class="settings-hint muted">The heuristic floor (ADR-0011) is the one signal that reads output <em>content</em>, so it's shown as a <em>dashed "~ waiting?" guess</em>, never asserted — and is dropped the instant the agent (or the kernel) reports something truthier. It runs only for hookless kinds; Claude and plain shells are never inspected.</p>
          </section>

          {/* ---- Agent adoption ---- */}
          <section class="settings-section">
            <h3>Remember hand-started agents</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Auto-keep agents you start by hand <span class="muted">— when you run an agent (e.g. type <code>claude</code>) in a pane, remember it as that pane's command so it persists and resumes on restart</span></>}
                checked={settings.autoAdoptAgents}
                onToggle={() => setSetting("autoAdoptAgents", !settings.autoAdoptAgents)}
              />
            </div>
            <p class="settings-hint muted">On: the pane is recorded a few seconds after the agent starts (so a one-off like <code>claude --help</code> is skipped). Off: a "📌 keep" button appears in the pane's chip to adopt it manually. For Claude, the current conversation's session is captured so a restart resumes it.</p>
          </section>

          {/* ---- Window & tray ---- */}
          <section class="settings-section">
            <h3>Window &amp; tray</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Close to tray <span class="muted">— the window's close button hides Loom instead of quitting (Quit from the tray menu still exits)</span></>}
                checked={settings.closeToTray}
                onToggle={() => setSetting("closeToTray", !settings.closeToTray)}
              />
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
            </div>
            <p class="settings-hint muted">Summons or hides the window from anywhere. A Tauri accelerator — modifiers <code>CommandOrControl</code>/<code>Alt</code>/<code>Shift</code>/<code>Super</code> joined with <code>+</code> (e.g. <code>Alt+Space</code>). Leave empty to disable. The tray icon (left-click) does the same.</p>
          </section>

          {/* ---- Session logging ---- */}
          <section class="settings-section">
            <h3>Session logging</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Log pane output to disk <span class="muted">— append each pane's raw output under the app's logs/ folder</span></>}
                checked={settings.sessionLogging}
                onToggle={() => setSetting("sessionLogging", !settings.sessionLogging)}
              />
            </div>
            <p class="settings-hint muted">Applies to terminals you open from now on. Useful for reviewing what a fleet of agents did; files can grow large.</p>
          </section>

          {/* ---- Agent resume: relaunch Claude panes with a stable session id (see lib/agents.ts) ---- */}
          <section class="settings-section">
            <h3>Agent resume</h3>
            <div class="settings-card">
              <ToggleRow
                label={<>Resume Claude Code sessions on restart <span class="muted">— each Claude pane comes back to its own conversation after you reopen Loom</span></>}
                checked={settings.resumeAgentSessions}
                onToggle={() => setSetting("resumeAgentSessions", !settings.resumeAgentSessions)}
              />
            </div>
            <p class="settings-hint muted">Loom pins each Claude pane its own session id (Claude stores the conversation under ~/.claude) and reattaches with --resume on restart. Panes whose command already sets --resume/--continue/--session-id are left as you wrote them.</p>
          </section>

          {/* ---- Agent history (ADR-0009): bounded-window pruning of the session/task log ---- */}
          <section class="settings-section">
            <h3>Agent history</h3>
            <p class="settings-sub">The searchable log of agent sessions &amp; tasks (History in the top bar). Pruned to this window at startup; set either to 0 to keep everything.</p>
            <div class="settings-card">
              <label class="settings-row">
                <span class="settings-label">Keep for <span class="muted">— days</span></span>
                <input
                  class="settings-input narrow"
                  type="number"
                  min="0"
                  max="3650"
                  step="1"
                  value={settings.historyMaxAgeDays}
                  onChange={(e) => setSetting("historyMaxAgeDays", Math.max(0, Math.floor(e.currentTarget.valueAsNumber || 0)))}
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">Max sessions</span>
                <input
                  class="settings-input narrow"
                  type="number"
                  min="0"
                  max="100000"
                  step="100"
                  value={settings.historyMaxSessions}
                  onChange={(e) => setSetting("historyMaxSessions", Math.max(0, Math.floor(e.currentTarget.valueAsNumber || 0)))}
                />
              </label>
            </div>
            <p class="settings-hint muted">Applied at the next launch: sessions older than the age, or beyond the newest N, are dropped (with their tasks).</p>
          </section>
          </Show>

          <Show when={tab() === "keys"}>
          {/* ---- Key bindings ---- */}
          <div class="settings-keys-intro">
            <p class="settings-hint muted">
              Every app shortcut lives in the {MOD_NAMESPACE} namespace so plain keys still reach the
              terminal. Click a shortcut, then press the new {MOD_NAMESPACE} combination (Esc cancels).
            </p>
            <button class="settings-btn" onClick={() => { setCapturing(null); resetKeybindings(); }}>
              Reset shortcuts
            </button>
          </div>
            <For each={KB_GROUPS}>
              {(group) => (
                <section class="settings-section">
                  <h3>{group.name}</h3>
                  <div class="settings-card">
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
                  </div>
                </section>
              )}
            </For>
          </Show>

          <Show when={tab() === "remote"}>
            <RemoteSettings />
          </Show>
        </div>

        <footer class="settings-foot">
          <button class="settings-btn" onClick={() => resetSettings()}>Reset to defaults</button>
          <span class="spacer" />
          <Show when={version()}>
            <span class="settings-version">Loom v{version()}</span>
          </Show>
          <span class="spacer" />
          <button class="settings-btn primary" onClick={() => props.onClose()}>Done</button>
        </footer>
      </div>
    </div>
  );
}

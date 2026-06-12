// App-wide preferences (everything the Settings page configures except the active theme,
// which has its own store in ./theme). A single reactive `createStore` is the source of
// truth; components read `settings.<field>` reactively and call `setSetting`. The whole
// object is persisted as one JSON blob under the "settings" key and reloaded at startup.
//
// Terminal-shaping fields (font/cursor/scrollback) are applied live to every open pane via
// reactive effects in Terminal.tsx — changing one here restyles all panes without respawn.

import { createStore } from "solid-js/store";
import { FONT_FAMILY, FONT_SIZE } from "../lib/theme";
import { loadState, saveState } from "../lib/persist";
import { DEFAULT_KEYBINDINGS, type ActionId, type Keybindings } from "../lib/keybindings";

const STORE_KEY = "settings";

export type CursorStyle = "block" | "bar" | "underline";

export interface Settings {
  // ---- Appearance (terminal text) ----
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  // ---- Terminal behaviour ----
  copyOnSelect: boolean;
  middleClickPaste: boolean;
  // ---- New terminals ----
  /** Shell binary new panes launch (empty = the OS `$SHELL`, then bash/sh). */
  defaultShell: string;
  /** Working folder the wizard pre-fills and plain shells fall back to (empty = `$HOME`). */
  defaultCwd: string;
  // ---- Safety ----
  /** Ask before closing a pane/workspace that still has a live process. */
  confirmClose: boolean;
  // ---- Notifications ----
  /** Pop a desktop notification when a pane raises attention while Termhaus is unfocused. */
  notifyOnAttention: boolean;
  // ---- Broadcast ----
  /** Append Enter (carriage return) to each broadcast message so it runs immediately. */
  broadcastNewline: boolean;
  /** Saved broadcast snippets for one-click re-send. */
  broadcastSnippets: string[];
  /** Recently-sent broadcast messages (oldest first), recalled with ↑/↓; persisted, capped at 50. */
  broadcastHistory: string[];
  /** Named broadcast target scopes — flip the bar to "claudes"/"reviewers" in one click. Each
   *  resolves through the same name glob as the Targets pattern field (lib/matching). */
  broadcastGroups: { name: string; pattern: string }[];
  /** Delay (ms) between panes when broadcasting; 0 = all at once (no stagger). */
  broadcastStaggerMs: number;
  // ---- Session logging ----
  /** Append each pane's raw output to a per-pane file under <config>/logs/ (opt-in). */
  sessionLogging: boolean;
  // ---- Keyboard ----
  /** Final key for each app shortcut; the Ctrl+Shift prefix is fixed (ADR-0005). */
  keybindings: Keybindings;
  // ---- Layout ----
  /** Width (px) of the left workspace rail; drag its right edge to resize. */
  railWidth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  middleClickPaste: false,
  defaultShell: "",
  defaultCwd: "",
  confirmClose: true,
  notifyOnAttention: false,
  broadcastNewline: true,
  broadcastSnippets: [],
  broadcastHistory: [],
  broadcastGroups: [],
  broadcastStaggerMs: 0,
  sessionLogging: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  railWidth: 168,
};

const [settings, setStore] = createStore<Settings>({ ...DEFAULT_SETTINGS });

/** Reactive read-only view for components. */
export { settings };

function persist() {
  void saveState(STORE_KEY, JSON.stringify(settings));
}

/** Update one setting and persist. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setStore(key, value);
  persist();
}

/** Terminal font-size bounds (mirrors the Settings slider). */
export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 24;

/** Nudge the terminal font size by `delta`, clamped to [FONT_SIZE_MIN, FONT_SIZE_MAX]. Every
 *  open pane restyles + refits live via the appearance effect in Terminal.tsx. */
export function adjustFontSize(delta: number) {
  const next = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, settings.fontSize + delta));
  if (next !== settings.fontSize) setSetting("fontSize", next);
}

/** Save a broadcast snippet (trimmed, de-duplicated, newest first, capped at 24). */
export function addBroadcastSnippet(text: string) {
  const t = text.trim();
  if (!t) return;
  const next = [t, ...settings.broadcastSnippets.filter((s) => s !== t)].slice(0, 24);
  setSetting("broadcastSnippets", next);
}

/** Remove a saved broadcast snippet. */
export function removeBroadcastSnippet(text: string) {
  setSetting("broadcastSnippets", settings.broadcastSnippets.filter((s) => s !== text));
}

/** Save (or overwrite) a named broadcast target group. Empty name/pattern is ignored. */
export function addBroadcastGroup(name: string, pattern: string) {
  const n = name.trim();
  const p = pattern.trim();
  if (!n || !p) return;
  const rest = settings.broadcastGroups.filter((g) => g.name !== n);
  setSetting("broadcastGroups", [{ name: n, pattern: p }, ...rest].slice(0, 24));
}

/** Remove a named broadcast target group. */
export function removeBroadcastGroup(name: string) {
  setSetting("broadcastGroups", settings.broadcastGroups.filter((g) => g.name !== name));
}

/** Record a sent broadcast message in the recall history (skip consecutive dupes, cap at 50). */
export function pushBroadcastHistory(text: string) {
  const v = text.trim();
  if (!v) return;
  const cur = settings.broadcastHistory;
  if (cur[cur.length - 1] === v) return;
  setSetting("broadcastHistory", [...cur, v].slice(-50));
}

/** Restore every setting to its default and persist. */
export function resetSettings() {
  setStore({ ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_KEYBINDINGS } });
  persist();
}

/** Rebind one action to a new final key (the Ctrl+Shift prefix is fixed). */
export function setKeybinding(action: ActionId, key: string) {
  setStore("keybindings", action, key.toLowerCase());
  persist();
}

/** Restore one action to its default key. */
export function resetKeybinding(action: ActionId) {
  setStore("keybindings", action, DEFAULT_KEYBINDINGS[action]);
  persist();
}

/** Restore every shortcut to its default. */
export function resetKeybindings() {
  setStore("keybindings", { ...DEFAULT_KEYBINDINGS });
  persist();
}

/** Load saved settings (merged over defaults so new fields get sane values). Call once at startup. */
export async function initSettings() {
  try {
    const raw = await loadState(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // Merge over defaults: tolerate older blobs missing newer fields, drop unknown keys.
      const merged: Settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (saved[k] !== undefined) (merged as unknown as Record<string, unknown>)[k] = saved[k];
      }
      // Deep-merge keybindings over defaults so actions added in a later version still get a
      // key when an older blob is loaded (and stray actions in the blob are dropped).
      merged.keybindings = { ...DEFAULT_KEYBINDINGS, ...(saved.keybindings ?? {}) };
      setStore(merged);
    }
  } catch (e) {
    console.error("failed to load settings", e);
  }
}

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
  // ---- Broadcast ----
  /** Append Enter (carriage return) to each broadcast message so it runs immediately. */
  broadcastNewline: boolean;
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
  broadcastNewline: true,
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

/** Restore every setting to its default and persist. */
export function resetSettings() {
  setStore({ ...DEFAULT_SETTINGS });
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
      setStore(merged);
    }
  } catch (e) {
    console.error("failed to load settings", e);
  }
}

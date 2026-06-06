// Theme selection: which named theme is active, applied to the document and persisted.
// Chrome colours are CSS custom properties keyed off `<html data-theme="…">` (App.css),
// so applying a theme is just setting that attribute. The active theme's xterm palette is
// exposed reactively (`currentTheme`) so every open <Terminal> restyles live on a switch.

import { createSignal } from "solid-js";
import { DEFAULT_THEME_ID, THEMES, themeById, type Theme } from "../lib/theme";
import { loadState, saveState } from "../lib/persist";

const STORE_KEY = "theme";

const [themeId, setThemeId] = createSignal(DEFAULT_THEME_ID);

/** Reactive id of the active theme. */
export { themeId };
/** All selectable themes (for the picker). */
export const themes = THEMES;
/** Reactive active theme (its xterm palette drives every pane). */
export const currentTheme = (): Theme => themeById(themeId());

function applyToDocument(theme: Theme) {
  document.documentElement.dataset.theme = theme.id;
}

/** Switch themes: restyle the chrome + every terminal, and remember the choice. */
export function setTheme(id: string) {
  const theme = themeById(id);
  setThemeId(theme.id);
  applyToDocument(theme);
  void saveState(STORE_KEY, theme.id);
}

/** Load the saved theme (or the default) and apply it. Call once before the first paint. */
export async function initTheme() {
  let id = DEFAULT_THEME_ID;
  try {
    const saved = await loadState(STORE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) id = saved;
  } catch (e) {
    console.error("failed to load theme", e);
  }
  setThemeId(id);
  applyToDocument(themeById(id));
}

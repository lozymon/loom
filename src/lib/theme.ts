// Theme registry. A theme is two things: a **chrome** palette (the app's own UI — rail,
// panes, wizard, …) and a **terminal** palette (the xterm.js colours inside each pane).
//
// The chrome palettes live in CSS as `:root` / `[data-theme="…"]` custom-property blocks
// (App.css) — that's where CSS belongs, and switching is just toggling `data-theme`. This
// module owns the bits CSS can't: the per-theme xterm `ITheme` (xterm needs a JS object)
// plus the theme list/metadata that drives the picker. The two are coupled by `id`:
// every theme here must have a matching `[data-theme="<id>"]` block in App.css (except
// `dark`, which is the `:root` default).

import type { ITheme } from "@xterm/xterm";

/** Monospace stack — system fonts first, no web-font fetch (keeps WebKitGTK snappy). */
export const FONT_FAMILY = 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, monospace';
export const FONT_SIZE = 13;

export interface Theme {
  id: string;
  name: string;
  /** Drives `color-scheme` + which ANSI family the terminal uses. */
  dark: boolean;
  /** xterm.js palette for panes on this theme. */
  terminal: ITheme;
}

// 16-colour ANSI families, shared across themes of the same brightness so only the
// background/foreground/cursor differ per theme.
const ANSI_DARK = {
  black: "#2a2b2e", red: "#e06c75", green: "#98c379", yellow: "#e0b85a",
  blue: "#5b8cff", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7d7d7",
  brightBlack: "#5c6370", brightRed: "#ff7a85", brightGreen: "#b5e08f", brightYellow: "#f0cc6a",
  brightBlue: "#7aa2ff", brightMagenta: "#d99aec", brightCyan: "#6fd3df", brightWhite: "#f5f5f5",
} as const;

const ANSI_LIGHT = {
  black: "#3b3f45", red: "#c5302f", green: "#2f8f3e", yellow: "#9a6a1f",
  blue: "#2f6bff", magenta: "#9a3fb0", cyan: "#2a8a9a", white: "#5a5f66",
  brightBlack: "#6b7079", brightRed: "#e0413f", brightGreen: "#3aa84d", brightYellow: "#b9802a",
  brightBlue: "#4f82ff", brightMagenta: "#b455c9", brightCyan: "#34a3b5", brightWhite: "#1c1e22",
} as const;

export const THEMES: Theme[] = [
  {
    id: "dark",
    name: "Termhaus Dark",
    dark: true,
    terminal: {
      background: "#191b20", foreground: "#e7e7ea",
      cursor: "#5b8cff", cursorAccent: "#191b20", selectionBackground: "#3a4d7a",
      ...ANSI_DARK,
    },
  },
  {
    id: "light",
    name: "Termhaus Light",
    dark: false,
    terminal: {
      background: "#ffffff", foreground: "#1c1e22",
      cursor: "#2f6bff", cursorAccent: "#ffffff", selectionBackground: "#b8d0ff",
      ...ANSI_LIGHT,
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    dark: true,
    terminal: {
      background: "#141826", foreground: "#e3e8f0",
      cursor: "#6ea8fe", cursorAccent: "#141826", selectionBackground: "#2d4a7a",
      ...ANSI_DARK,
    },
  },
  {
    id: "paper",
    name: "Paper",
    dark: false,
    terminal: {
      background: "#faf7f0", foreground: "#2b2620",
      cursor: "#5a55d6", cursorAccent: "#faf7f0", selectionBackground: "#d8d2f0",
      ...ANSI_LIGHT,
    },
  },
];

export const DEFAULT_THEME_ID = "dark";

/** Look up a theme by id, falling back to the default if it's unknown. */
export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

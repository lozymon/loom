// Shared xterm look: font stack + colour theme, in one place so every pane renders
// identically and a future theme picker has a single source to swap (PLAN M5 "themes/fonts").
// The palette is a calm dark scheme tuned to the app chrome (#1a1b1e background).

import type { ITheme } from "@xterm/xterm";

/** Monospace stack — system fonts first, no web-font fetch (keeps WebKitGTK snappy). */
export const FONT_FAMILY = 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, monospace';
export const FONT_SIZE = 13;

/** The default dark theme; matches the pane chrome and gives a full 16-colour ANSI set. */
export const TERMINAL_THEME: ITheme = {
  background: "#1a1b1e",
  foreground: "#e6e6e6",
  cursor: "#5b8cff",
  cursorAccent: "#1a1b1e",
  selectionBackground: "#3a4d7a",
  black: "#2a2b2e",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e0b85a",
  blue: "#5b8cff",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7d7d7",
  brightBlack: "#5c6370",
  brightRed: "#ff7a85",
  brightGreen: "#b5e08f",
  brightYellow: "#f0cc6a",
  brightBlue: "#7aa2ff",
  brightMagenta: "#d99aec",
  brightCyan: "#6fd3df",
  brightWhite: "#f5f5f5",
};

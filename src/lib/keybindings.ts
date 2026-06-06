// The keybinding registry: the single source of truth for every app shortcut. All app
// shortcuts live in the Ctrl+Shift namespace (ADR-0005) so plain Ctrl+C still reaches the
// PTY — therefore only the *final key* of each `Ctrl+Shift+<key>` combo is rebindable, not
// the modifiers. A binding's value is the lowercased `KeyboardEvent.key` (e.g. "d",
// "enter", "arrowup", "pageup"); Terminal.tsx dispatches by reverse-looking-up the pressed
// key, and the Settings page edits the same map (stored in the `settings` store).

export type ActionId =
  | "focus-up"
  | "focus-down"
  | "focus-left"
  | "focus-right"
  | "split-right"
  | "split-down"
  | "close-pane"
  | "toggle-zoom"
  | "new-workspace"
  | "prev-workspace"
  | "next-workspace"
  | "copy"
  | "paste"
  | "search"
  | "capture-region";

export interface ActionDef {
  id: ActionId;
  /** Human label shown in the Settings list. */
  label: string;
  /** Section the action is grouped under in the Settings list. */
  group: "Focus" | "Panes" | "Workspaces" | "Clipboard & search" | "Capture";
  /** Default final key (lowercased `KeyboardEvent.key`). */
  defaultKey: string;
}

// Ordered for display; grouped headings are derived from `group`.
export const ACTIONS: ActionDef[] = [
  { id: "focus-up", label: "Focus pane above", group: "Focus", defaultKey: "arrowup" },
  { id: "focus-down", label: "Focus pane below", group: "Focus", defaultKey: "arrowdown" },
  { id: "focus-left", label: "Focus pane left", group: "Focus", defaultKey: "arrowleft" },
  { id: "focus-right", label: "Focus pane right", group: "Focus", defaultKey: "arrowright" },
  { id: "split-right", label: "Split right", group: "Panes", defaultKey: "d" },
  { id: "split-down", label: "Split down", group: "Panes", defaultKey: "e" },
  { id: "close-pane", label: "Close pane", group: "Panes", defaultKey: "w" },
  { id: "toggle-zoom", label: "Toggle zoom", group: "Panes", defaultKey: "enter" },
  { id: "new-workspace", label: "New workspace", group: "Workspaces", defaultKey: "t" },
  { id: "prev-workspace", label: "Previous workspace", group: "Workspaces", defaultKey: "pageup" },
  { id: "next-workspace", label: "Next workspace", group: "Workspaces", defaultKey: "pagedown" },
  { id: "copy", label: "Copy selection", group: "Clipboard & search", defaultKey: "c" },
  { id: "paste", label: "Paste", group: "Clipboard & search", defaultKey: "v" },
  { id: "search", label: "Find in scrollback", group: "Clipboard & search", defaultKey: "f" },
  { id: "capture-region", label: "Snapshot region → focused pane", group: "Capture", defaultKey: "s" },
];

/** A map from every action to its bound final key. */
export type Keybindings = Record<ActionId, string>;

export const DEFAULT_KEYBINDINGS: Keybindings = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.defaultKey]),
) as Keybindings;

/** Which action (if any) the pressed final key triggers. First match wins on conflict. */
export function actionForKey(bindings: Keybindings, key: string): ActionId | null {
  const k = key.toLowerCase();
  for (const a of ACTIONS) if (bindings[a.id] === k) return a.id;
  return null;
}

const PRETTY_KEY: Record<string, string> = {
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  enter: "Enter", pageup: "PgUp", pagedown: "PgDn",
  " ": "Space", spacebar: "Space", tab: "Tab", backspace: "Backspace",
  escape: "Esc", home: "Home", end: "End", delete: "Del", insert: "Ins",
};

/** Render a stored final key as a full combo, e.g. "d" → "Ctrl+Shift+D". */
export function formatBinding(key: string): string {
  const k = key.toLowerCase();
  const pretty = PRETTY_KEY[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  return `Ctrl+Shift+${pretty}`;
}

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "altgraph"]);

/** Is this a lone modifier press (no real key yet)? */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key.toLowerCase());
}

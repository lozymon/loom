// Keyboard shortcuts cheat-sheet (Ctrl+Shift+?). A read-only modal listing every app shortcut,
// read straight from ACTIONS in lib/keybindings.ts (so it stays in sync and reflects live rebinds)
// and grouped by section. Complements the command palette and Settings' editable list — this one
// is a quick glance, opened from the title bar's ? button, the palette, or the keybinding.

import { For, onCleanup, onMount } from "solid-js";
import { ACTIONS, formatBinding, type ActionDef } from "../lib/keybindings";
import { settings } from "../stores/settings";

// Group actions by their section, preserving first-seen order (same derivation as Settings).
const GROUPS: { name: string; actions: ActionDef[] }[] = [...new Set(ACTIONS.map((a) => a.group))].map((name) => ({
  name,
  actions: ACTIONS.filter((a) => a.group === name),
}));

export default function ShortcutsOverlay(props: { onClose: () => void }) {
  // Capture phase so Escape closes even while a terminal holds focus (xterm swallows it otherwise).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="settings-backdrop" onClick={() => props.onClose()}>
      <div class="dialog shortcuts" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <span class="dialog-title">⌨ Keyboard shortcuts</span>
          <button class="settings-x" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
        </header>
        <div class="shortcuts-body">
          <For each={GROUPS}>
            {(group) => (
              <section class="shortcuts-group">
                <h4 class="kb-group">{group.name}</h4>
                <For each={group.actions}>
                  {(a) => (
                    <div class="shortcuts-row">
                      <span class="shortcuts-label">{a.label}</span>
                      <kbd class="shortcuts-key">{formatBinding(settings.keybindings[a.id])}</kbd>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
        <footer class="shortcuts-foot">
          App shortcuts use the <kbd class="shortcuts-key">Ctrl+Shift</kbd> namespace · rebind them in Settings
        </footer>
      </div>
    </div>
  );
}

// The global summon/hide hotkey (the system-tray "bigger bet"). Registered from TS because the
// accelerator is a user setting (settings.globalHotkey); the Rust side just hosts the plugin. The
// hotkey toggles the window the same way the tray's left-click/menu does.

import { register, unregister, isRegistered } from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The accelerator currently registered, so a settings change can drop the old binding first.
let current: string | null = null;

/** Show+focus the window if it's hidden, else hide it — mirrors the tray's summon/dismiss. */
export async function toggleWindow(): Promise<void> {
  const w = getCurrentWindow();
  try {
    if (await w.isVisible()) {
      await w.hide();
    } else {
      await w.unminimize();
      await w.show();
      await w.setFocus();
    }
  } catch (e) {
    console.error("toggle window failed", e);
  }
}

/** (Re)register the global summon hotkey. An empty accelerator just unregisters; an unchanged one
 *  is a no-op. A bad/already-taken accelerator is logged, not thrown — the tray still works. */
export async function applyGlobalHotkey(accel: string): Promise<void> {
  const next = accel.trim();
  if (next === current) return;
  if (current) {
    try { await unregister(current); } catch (e) { console.error("unregister hotkey failed", e); }
    current = null;
  }
  if (!next) return;
  try {
    // Reclaim it if a previous (crashed) instance left it registered.
    if (await isRegistered(next)) await unregister(next);
    await register(next, (e) => { if (e.state === "Pressed") void toggleWindow(); });
    current = next;
  } catch (e) {
    console.error(`failed to register global hotkey "${next}"`, e);
  }
}

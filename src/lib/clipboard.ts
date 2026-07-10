// OS clipboard writes. On Linux, arboard (what @tauri-apps/plugin-clipboard-manager uses) owns the
// X11 CLIPBOARD selection in a way that doesn't serve *other* apps inside this WebKitGTK app, so a
// copy in Loom pasted as empty elsewhere. The `clipboard_set_text` Rust command writes through GTK's
// clipboard on Linux (and the plugin on other platforms), which exports correctly. Reading is
// unaffected (arboard reads fine), so paste keeps using the plugin's `readText`.

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Copy `text` to the OS clipboard so other applications can paste it. Falls back to the plugin if
 *  the Rust command isn't reachable (e.g. a non-Tauri test env). */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await invoke("clipboard_set_text", { text });
  } catch {
    await writeText(text);
  }
}

// Tear-off / re-dock of panes into their own windows (the multi-window "bigger bet").
//
// The PTY itself never moves — it lives in the Rust process keyed by handle (ADR-0002). Tearing a
// pane off just re-points its output Channel (lib/ptyClient `retargetPty` → `pty_retarget`) at a
// new WebviewWindow, while the main grid shows a placeholder. When that window closes we flip the
// pane to "re-docking" so the main window re-mounts its Terminal, which rebinds to the same handle.
//
// State machine per detached pane:
//   detach  → { handle, redocking:false }  (main grid: placeholder; PTY → new window)
//   close   → { handle, redocking:true }   (main grid: re-mount Terminal → start() rebinds)
//   rebind  → forgotten                    (back to a normal docked pane)

import { createStore } from "solid-js/store";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { PaneId, PtyHandle } from "../ipc/protocol";

interface DetachState {
  handle: PtyHandle;
  redocking: boolean;
}

const [detached, setDetached] = createStore<Record<PaneId, DetachState>>({});

/** Reactive view: read `detached[id]` to react to a pane's detach state. */
export { detached };

/** Show the main-grid placeholder for this pane? (detached, and not yet re-docking). */
export function isDetachedPlaceholder(id: PaneId): boolean {
  const d = detached[id];
  return !!d && !d.redocking;
}

/** The saved live PTY handle for a (re-)docking pane, so Terminal.start can rebind. */
export function detachedHandle(id: PaneId): PtyHandle | null {
  return detached[id]?.handle ?? null;
}

/** Drop a pane's detach state once it has re-docked (or its window failed to open). */
export function forgetDetached(id: PaneId) {
  if (detached[id]) setDetached(id, undefined as unknown as DetachState);
}

/**
 * Tear pane `id` off into its own window. Marks it detached (→ placeholder) and opens the window
 * pointed at the same bundle with `?detach=…` so it renders a single-pane view that claims the
 * PTY's stream. On failure we re-dock immediately and re-throw so the caller can un-gate its kill.
 */
export async function detachPaneToWindow(id: PaneId, handle: PtyHandle, title: string): Promise<void> {
  setDetached(id, { handle, redocking: false });
  const label = `pane-${id}`;
  const url = `index.html?detach=${id}&handle=${handle}&title=${encodeURIComponent(title)}`;
  try {
    const w = new WebviewWindow(label, {
      url,
      title: `${title} — Termhaus`,
      width: 760,
      height: 480,
      decorations: true,
      focus: true,
    });
    // Re-dock when the torn-off window is destroyed (closed by the user or on app quit).
    void w.once("tauri://destroyed", () => redock(id));
    void w.once("tauri://error", (e) => {
      console.error("detached window error", e);
      redock(id);
    });
  } catch (e) {
    console.error("failed to open detached window", e);
    forgetDetached(id);
    throw e;
  }
}

/** Flip a detached pane to re-docking, so the main window re-mounts + rebinds it. No-op if the
 *  pane was never detached (e.g. a duplicate destroyed-event). */
export function redock(id: PaneId) {
  if (detached[id] && !detached[id].redocking) setDetached(id, "redocking", true);
}

/** Bring a torn-off pane home from the main grid: close its window (whose destroyed handler
 *  re-docks it). Falls back to a direct re-dock if the window is already gone. */
export async function recallPane(id: PaneId) {
  try {
    const w = await WebviewWindow.getByLabel(`pane-${id}`);
    if (w) { await w.destroy(); return; }
  } catch (e) {
    console.error("recall pane failed", e);
  }
  redock(id);
}

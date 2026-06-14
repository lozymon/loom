// Scrollback handoff for multi-window tear-off / re-dock.
//
// The PTY never moves (it lives in Rust keyed by handle, ADR-0002) — but its *painted* scrollback
// lives in the xterm.js buffer of whichever window rendered it. When a live pane moves to another
// window, `retargetPty` only re-points the live output stream, so the destination window starts
// blank and only sees *future* bytes (a full-screen TUI like `top` repaints, but a shell's printed
// history is lost). To bridge that, the source window serializes its buffer (SGR styling included)
// and the destination replays it with `term.write()` before the live stream resumes.
//
// The two windows are separate webview JS contexts, so module state isn't shared — but they're the
// same origin, so `localStorage` is. We stash the snapshot there: written before the destination
// window mounts (tear-off) or before the source window is destroyed (re-dock), and taken once on
// the other side. This keeps the whole feature in TS (no Rust change; ADR: UX/state stays in TS).

import type { SerializeAddon } from "@xterm/addon-serialize";
import type { PtyHandle } from "../ipc/protocol";

const key = (handle: PtyHandle) => `th:replay:${handle}`;

/**
 * Snapshot a terminal's screen + scrollback and stash it for the window that next binds this PTY.
 * Best-effort: a huge buffer can blow the localStorage quota, so we retry with progressively
 * smaller scrollback caps and, failing that, clear any stale snapshot rather than replay garbage.
 */
export function stashScrollback(handle: PtyHandle, addon: SerializeAddon): void {
  for (const opts of [undefined, { scrollback: 1000 }, { scrollback: 200 }]) {
    try {
      localStorage.setItem(key(handle), addon.serialize(opts));
      return;
    } catch {
      /* serialize threw, or setItem hit the quota — try a smaller snapshot */
    }
  }
  try {
    localStorage.removeItem(key(handle));
  } catch {
    /* ignore */
  }
}

/** Take (and clear) the stashed snapshot for this PTY, or null if there is none. */
export function takeScrollback(handle: PtyHandle): string | null {
  try {
    const data = localStorage.getItem(key(handle));
    if (data !== null) localStorage.removeItem(key(handle));
    return data;
  } catch {
    return null;
  }
}

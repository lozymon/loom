// Voice dictation client (loom-voce). The dictation hotkey calls this to spawn the `loom-voce`
// helper for a single utterance targeting a pane; Rust (`voce_dictate`) launches it detached and
// emits `voce://done` when it exits. We drive the pane's "listening" chip indicator around that:
// raise it before the spawn, clear it on exit (or on a spawn failure). loom-voce delivers the
// transcript over the control bus (`loom send <pane>`) — Loom never reads pane output (ADR-0001).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PaneId } from "../ipc/protocol";
import { activeWorkspace, resolvePaneByName } from "../stores/workspace";
import { setListening, clearListening } from "../stores/activity";

const VOCE_DONE_EVENT = "voce://done";

/** Start voice dictation into a pane addressed by its id (for the indicator) and routing name
 *  (its auto-name / `loom send` handle). No-op without a name. */
export async function dictateIntoPane(paneId: PaneId, name: string): Promise<void> {
  if (!name.trim()) return;
  setListening(paneId);
  try {
    // model: null → loom-voce uses its default (base.en). A per-app model setting can pass it here.
    await invoke("voce_dictate", { pane: name, model: null });
  } catch (e) {
    clearListening(paneId);
    window.alert(`Couldn't start voice dictation:\n${e}`);
  }
}

/** Dictate into the active workspace's focused pane — the global-keybinding path (App.tsx), used
 *  when focus isn't on a terminal. */
export async function dictateIntoActivePane(): Promise<void> {
  const ws = activeWorkspace();
  const id = ws?.focused ?? null;
  if (id == null) return;
  await dictateIntoPane(id, ws?.panes[id]?.title ?? "");
}

/** Wire the helper-exit event once (App onMount): clear the pane's "listening" indicator when its
 *  loom-voce exits. Returns an unlisten thunk for onCleanup. */
export function initVoceExitListener(): () => void {
  const un = listen<string>(VOCE_DONE_EVENT, (e) => {
    const r = resolvePaneByName(e.payload);
    if ("paneId" in r) clearListening(r.paneId);
  });
  return () => void un.then((f) => f());
}

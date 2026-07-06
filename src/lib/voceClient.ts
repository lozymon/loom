// Voice dictation client (loom-voce). The dictation hotkey calls this to spawn the `loom-voce`
// helper for a single utterance targeting a pane; Rust (`voce_dictate`) launches it detached and
// emits `voce://done` when it exits. We drive the pane's "listening" chip indicator around that:
// raise it before the spawn, clear it on exit (or on a spawn failure). loom-voce delivers the
// transcript over the control bus (`loom send <pane>`) — Loom never reads pane output (ADR-0001).

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PaneId } from "../ipc/protocol";
import { activeWorkspace, resolvePaneByName } from "../stores/workspace";
import { activity, setListening, clearListening, setDownloading, clearDownloading } from "../stores/activity";
import { settings } from "../stores/settings";

const VOCE_DONE_EVENT = "voce://done";
const VOCE_LEVEL_EVENT = "voce://level";
const VOCE_DOWNLOAD_EVENT = "voce://download";

/** Latest mic level (RMS, ~0.0–0.3 for speech) per capturing pane name, streamed from loom-voce
 *  while it listens. Read reactively by the dictation overlay to drive its live waveform; entries
 *  are cleared when the pane's helper exits. */
const [voiceLevels, setVoiceLevels] = createSignal<Record<string, number>>({});
export { voiceLevels };

/** Start voice dictation into a pane addressed by its id (for the indicator) and routing name
 *  (its auto-name / `loom send` handle). No-op without a name. */
export async function dictateIntoPane(paneId: PaneId, name: string): Promise<void> {
  if (!name.trim()) return;
  // Ignore a repeat hotkey while this pane is already capturing — a monologue is finished with
  // <Enter> (voce_finish) or cancelled with Esc, not by starting a second overlapping helper.
  if (activity[paneId]?.listening) return;
  setListening(paneId);
  try {
    // Pass the configured Whisper model + optional forced language (Settings → Voice dictation).
    // A multilingual model auto-detects the language; a non-empty voiceLanguage pins it instead.
    // Empty strings → null, so loom-voce falls back to its own default / auto-detect.
    await invoke("voce_dictate", {
      pane: name,
      model: settings.voiceModel.trim() || null,
      language: settings.voiceLanguage.trim() || null,
    });
  } catch (e) {
    clearListening(paneId);
    window.alert(`Couldn't start voice dictation:\n${e}`);
  }
}

/** Finish the monologue capturing for a pane addressed by its routing name (<Enter> in the listening
 *  overlay): loom-voce stops recording, transcribes, and types the text into the pane. The pane's
 *  "listening" indicator clears via the normal `voce://done` path. No-op without a name. */
export async function finishDictation(name: string): Promise<void> {
  if (!name.trim()) return;
  try {
    await invoke("voce_finish", { pane: name });
  } catch {
    // Nothing was capturing (already exited) — the overlay will clear on its own.
  }
}

/** Abort the voice dictation capturing for a pane addressed by its routing name (Esc in the
 *  listening overlay). Kills the loom-voce helper, which discards the utterance; the pane's
 *  "listening" indicator clears via the normal `voce://done` path. No-op without a name. */
export async function cancelDictation(name: string): Promise<void> {
  if (!name.trim()) return;
  try {
    await invoke("voce_cancel", { pane: name });
  } catch {
    // Nothing was capturing (already exited) — the overlay will clear on its own.
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

/** Wire the voice-dictation events once (App onMount): stream mic levels into `voiceLevels` for the
 *  overlay waveform, and clear a pane's "listening" indicator (and its level) when its loom-voce
 *  exits. Returns a single unlisten thunk for onCleanup. */
export function initVoceExitListener(): () => void {
  const done = listen<string>(VOCE_DONE_EVENT, (e) => {
    const r = resolvePaneByName(e.payload);
    if ("paneId" in r) {
      clearListening(r.paneId);
      // Belt-and-suspenders: if the helper died mid-download, clear the downloading state too so it
      // can't get stuck on "Downloading model…".
      clearDownloading(r.paneId);
    }
    // Drop the pane's level so a re-dictation starts from a clean (flat) waveform.
    setVoiceLevels((m) => {
      if (!(e.payload in m)) return m;
      const next = { ...m };
      delete next[e.payload];
      return next;
    });
  });
  const level = listen<{ pane: string; level: number }>(VOCE_LEVEL_EVENT, (e) => {
    setVoiceLevels((m) => ({ ...m, [e.payload.pane]: e.payload.level }));
  });
  // First-use model download progress: set/clear the pane's downloading state so the overlay shows
  // "Downloading model…" with a live size readout until the model lands (`done: true`).
  const download = listen<{ pane: string; model: string; bytes: number; done: boolean }>(
    VOCE_DOWNLOAD_EVENT,
    (e) => {
      const r = resolvePaneByName(e.payload.pane);
      if (!("paneId" in r)) return;
      if (e.payload.done) clearDownloading(r.paneId);
      else setDownloading(r.paneId, e.payload.model, e.payload.bytes);
    },
  );
  return () => {
    void done.then((f) => f());
    void level.then((f) => f());
    void download.then((f) => f());
  };
}

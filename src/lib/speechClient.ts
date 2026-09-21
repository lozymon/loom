// Read-aloud client (Piper TTS). The read-aloud key calls this with a pane's latest agent reply;
// Rust (`speech_speak`) synthesises and plays it, then emits `speech://done`. We keep a single
// "who is speaking" signal around that, so the title bar can show which pane is talking and the
// key can toggle itself off.
//
// Opacity (ADR-0001) is intact: the text comes from Claude's own on-disk transcript
// (`claude_last_reply`), never from pane output.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PaneId } from "../ipc/protocol";
import { speakableText } from "./speech";
import { settings } from "../stores/settings";
import { activeWorkspace } from "../stores/workspace";

const SPEECH_DONE_EVENT = "speech://done";
const SPEECH_DOWNLOAD_EVENT = "speech://download";

/** The pane currently being read aloud, or null when nothing is speaking. One at a time — a new
 *  utterance cancels the old one in Rust, so this is a single value rather than a set. */
const [speakingPane, setSpeakingPane] = createSignal<PaneId | null>(null);
export { speakingPane };

/** True while a voice model is downloading on first use (a ~60 MB fetch), so the UI can say so
 *  instead of appearing to do nothing for half a minute. */
const [voiceDownloading, setVoiceDownloading] = createSignal(false);
export { voiceDownloading };

/** Wire the Rust speech events once (App onMount): clear the speaking pane when an utterance ends
 *  (finished, cancelled, or failed) and track the first-use voice download. Returns a single
 *  unlisten thunk for onCleanup, mirroring `initVoceExitListener`. */
export function initSpeechListener(): () => void {
  const done = listen<{ error: string | null }>(SPEECH_DONE_EVENT, (e) => {
    setSpeakingPane(null);
    setVoiceDownloading(false);
    if (e.payload?.error) window.alert(`Read aloud failed:\n${e.payload.error}`);
  });
  const download = listen<{ voice: string; bytes: number; done: boolean }>(
    SPEECH_DOWNLOAD_EVENT,
    (e) => setVoiceDownloading(!e.payload?.done),
  );
  return () => {
    void done.then((f) => f());
    void download.then((f) => f());
  };
}

/** The agent's latest reply in `sessionId`, as plain text, or null if it hasn't said anything.
 *  Best-effort: a failure reads as "nothing to say" rather than throwing into a keypress. */
export async function lastAgentReply(sessionId: string): Promise<string | null> {
  try {
    return await invoke<string | null>("claude_last_reply", { sessionId });
  } catch (e) {
    console.error("claude_last_reply failed", e);
    return null;
  }
}

/** Stop whatever is being read. Idempotent. */
export async function stopSpeaking(): Promise<void> {
  try {
    await invoke("speech_stop");
  } catch (e) {
    console.error("speech_stop failed", e);
  }
  setSpeakingPane(null);
}

/** Is ffmpeg available for the exact pitch-preserving rate change? Without it a requested speed is
 *  approximated by piper's own non-linear rate knob, which saturates near 1.9x. */
export async function stretchAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("speech_stretch_available");
  } catch {
    return false;
  }
}

/** Is piper installed and resolvable? Settings and `loom doctor` surface this so a missing install
 *  is a visible, fixable state rather than a key that does nothing. */
export async function speechAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("speech_available");
  } catch {
    return false;
  }
}

/**
 * Read `markdown` aloud on behalf of `paneId`. Strips it to speakable prose first (lib/speech), so
 * code blocks and URLs don't get spelled out. A no-op when there's nothing speakable left.
 * Returns whether speech actually started.
 */
export async function speakForPane(paneId: PaneId, markdown: string): Promise<boolean> {
  const text = speakableText(markdown);
  if (!text) return false;
  setSpeakingPane(paneId);
  try {
    await invoke("speech_speak", {
      text,
      voice: settings.readAloudVoice.trim() || null,
      speed: settings.readAloudSpeed || null,
    });
    return true;
  } catch (e) {
    setSpeakingPane(null);
    window.alert(`Couldn't read aloud:\n${e}`);
    return false;
  }
}

/**
 * The read-aloud action for a pane: toggle. Speaking → stop. Otherwise pull the pane's agent's
 * latest reply from its transcript and speak it. `sessionId` is the pane's Claude session; without
 * one there's no transcript to read, which we report rather than failing silently.
 */
export async function readPaneAloud(paneId: PaneId, sessionId: string | undefined): Promise<void> {
  if (speakingPane() !== null) {
    await stopSpeaking();
    return;
  }
  if (!sessionId) {
    window.alert("Read aloud needs a Claude pane — this pane has no conversation to read.");
    return;
  }
  const reply = await lastAgentReply(sessionId);
  if (!reply) {
    window.alert("Nothing to read yet — the agent hasn't replied in this pane.");
    return;
  }
  await speakForPane(paneId, reply);
}

/** Read the active workspace's focused pane aloud — the global-keybinding path (App.tsx), used
 *  when focus isn't on a terminal. Mirrors `dictateIntoActivePane`. */
export async function readActivePaneAloud(): Promise<void> {
  const ws = activeWorkspace();
  const id = ws?.focused ?? null;
  if (id == null) return;
  await readPaneAloud(id, ws?.panes[id]?.sessionId);
}

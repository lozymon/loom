// Ephemeral per-pane "attention" state — the signals that tell you which of a fleet of panes
// needs you, without ever parsing pane output (ADR-0001). Four orthogonal signals:
//
//   • unseen    — the pane produced output while it wasn't the focused/active pane (a metadata
//     fact: bytes arrived; we never look at what they say).
//   • bell      — the pane rang the terminal bell (BEL); agents/builds often ring on done/prompt.
//   • busy      — a foreground command is running vs. sitting at the shell prompt, polled from the
//     PTY's foreground process group in Rust (pty_busy). null = unknown.
//   • attention — a sticky "needs you" flag drawn as a coloured border around the pane. Raised
//     automatically on the busy→idle transition (a command just finished while you weren't
//     looking) or explicitly by a process inside the pane via `loom attention` (ADR-0007). Like
//     busy, it's metadata only — the foreground-pgrp fact or an inbound command, never output.
//
// unseen/bell/attention are "sticky until looked at" (cleared by seePane on focus); busy is a
// live poll. This store is not persisted and not part of the layout — pure UI state by PaneId.

import { createStore } from "solid-js/store";
import type { PaneId } from "../ipc/protocol";

export interface PaneActivity {
  unseen: boolean;
  bell: boolean;
  busy: boolean | null;
  attention: boolean;
  // A short agent-pushed status label (`loom status "running tests"`), shown in the title bar and
  // overview tile. "" = no status. Like attention, it's metadata only — never read from output —
  // but unlike the sticky signals it is NOT cleared by looking at the pane; only the agent (or a
  // respawn) clears it. Lets overview read as a fleet dashboard.
  status: string;
  // Set to the OS error when this pane's session-log write broke mid-stream (disk full, file
  // removed); "" = logging fine / off. Pushed from Rust (LOG_ERROR_EVENT), drawn as a warning on
  // the pane's log control so a silently-truncated log can't keep looking like it's recording.
  // Cleared only by a respawn (which re-opens the file) — not by looking at the pane.
  logError: string;
  // True while a `loom-voce` voice-dictation helper is capturing for this pane (raised when the
  // dictation hotkey spawns it, cleared on the helper's exit via the Rust `voce://done` event).
  // Pure UI state — drives the 🎙 chip indicator; nothing is read from pane output (ADR-0001).
  listening: boolean;
  // While a first-use Whisper model download is running for this pane's dictation helper: the model
  // name being fetched ("" = not downloading) and bytes fetched so far, pushed from Rust
  // (`voce://download`, which watches loom-voce's cache). Drives the "Downloading model…" state in
  // the listening overlay so the one-time fetch reads as progress, not a hang.
  downloadingModel: string;
  downloadedBytes: number;
  // Epoch-ms of this pane's most recent PTY output (0 = none yet). Updated from byte-flow *timing*
  // only — we timestamp that bytes arrived, never look at them (ADR-0001) — and feeds idle/stuck
  // detection (lib/idle.ts). Throttled to ~2 writes/s so a flood doesn't churn the store.
  lastOutputAt: number;
  // Derived "idle/stuck" flag (AGENTIC §1b): a busy agent pane that's gone silent past the
  // configured threshold — probably wedged on a prompt. Recomputed each metadata poll in
  // Terminal.tsx (setStuck); counts toward "needs you" like `attention`. Not sticky (it clears
  // when output resumes, the pane goes idle, or you look at it).
  stuck: boolean;
}

const BLANK: PaneActivity = { unseen: false, bell: false, busy: null, attention: false, status: "", logError: "", listening: false, downloadingModel: "", downloadedBytes: 0, lastOutputAt: 0, stuck: false };

const [activity, setActivity] = createStore<Record<PaneId, PaneActivity>>({});

/** Reactive read-only view. Read `activity[id]?.unseen` etc. (undefined = no signal yet). */
export { activity };

function ensure(id: PaneId) {
  if (!activity[id]) setActivity(id, { ...BLANK });
}

/** Mark that output arrived in a pane the user isn't currently looking at. */
export function noteUnseen(id: PaneId) {
  ensure(id);
  if (!activity[id].unseen) setActivity(id, "unseen", true);
}

/** Mark that a pane rang the bell. */
export function noteBell(id: PaneId) {
  ensure(id);
  if (!activity[id].bell) setActivity(id, "bell", true);
}

/** Update a pane's busy (foreground-command) state from a poll. */
export function setBusy(id: PaneId, busy: boolean | null) {
  ensure(id);
  if (activity[id].busy !== busy) setActivity(id, "busy", busy);
}

/** Timestamp that output just arrived in a pane (byte-flow timing only, never content — ADR-0001).
 *  Throttled to ~2 writes/s so a flood doesn't churn the store; the 0.5s granularity is far finer
 *  than the idle threshold that consumes it. */
export function noteOutput(id: PaneId) {
  ensure(id);
  const now = Date.now();
  if (now - activity[id].lastOutputAt >= 500) setActivity(id, "lastOutputAt", now);
}

/** Set a pane's derived idle/stuck flag (recomputed each metadata poll; see lib/idle.ts). */
export function setStuck(id: PaneId, stuck: boolean) {
  ensure(id);
  if (activity[id].stuck !== stuck) setActivity(id, "stuck", stuck);
}

/** Raise a pane's sticky attention flag (busy→idle transition, or `loom attention`). Returns true
 *  only when it was newly raised (was clear before) — callers use that to fire a one-shot OS
 *  notification without re-notifying a pane that's already flagged. */
export function noteAttention(id: PaneId): boolean {
  ensure(id);
  if (activity[id].attention) return false;
  setActivity(id, "attention", true);
  return true;
}

/** Clear a pane's attention flag explicitly (`loom attention --clear`). */
export function clearAttention(id: PaneId) {
  if (activity[id]?.attention) setActivity(id, "attention", false);
}

/** Set a pane's agent-pushed status label (`loom status "…"`); empty text clears it. Unlike the
 *  sticky signals this survives focus — only the agent or a respawn clears it. */
export function setStatus(id: PaneId, text: string) {
  ensure(id);
  const next = text.trim();
  if (activity[id].status !== next) setActivity(id, "status", next);
}

/** Clear a pane's status label (respawn, or `loom status --clear`). */
export function clearStatus(id: PaneId) {
  if (activity[id]?.status) setActivity(id, "status", "");
}

/** Flag that a pane's session-log write failed mid-stream (Rust LOG_ERROR_EVENT). */
export function setLogError(id: PaneId, error: string) {
  ensure(id);
  if (activity[id].logError !== error) setActivity(id, "logError", error);
}

/** Clear a pane's session-log error (on respawn — the log file is re-opened). */
export function clearLogError(id: PaneId) {
  if (activity[id]?.logError) setActivity(id, "logError", "");
}

/** Raise the "listening" flag while voice dictation captures for a pane (dictation hotkey). */
export function setListening(id: PaneId) {
  ensure(id);
  if (!activity[id].listening) setActivity(id, "listening", true);
}

/** Clear the "listening" flag (loom-voce exited — the `voce://done` event, or a spawn failure). */
export function clearListening(id: PaneId) {
  if (activity[id]?.listening) setActivity(id, "listening", false);
}

/** Set the first-use model-download state for a pane's dictation helper (`voce://download`). */
export function setDownloading(id: PaneId, model: string, bytes: number) {
  ensure(id);
  if (activity[id].downloadingModel !== model) setActivity(id, "downloadingModel", model);
  if (activity[id].downloadedBytes !== bytes) setActivity(id, "downloadedBytes", bytes);
}

/** Clear the model-download state (download finished, or the helper exited). */
export function clearDownloading(id: PaneId) {
  if (activity[id]?.downloadingModel) setActivity(id, "downloadingModel", "");
  if (activity[id]?.downloadedBytes) setActivity(id, "downloadedBytes", 0);
}

/** The user looked at the pane — clear its sticky unseen/bell/attention signals (and the live
 *  stuck flag, so focusing a wedged pane drops it immediately rather than at the next poll). */
export function seePane(id: PaneId) {
  if (!activity[id]) return;
  if (activity[id].unseen) setActivity(id, "unseen", false);
  if (activity[id].bell) setActivity(id, "bell", false);
  if (activity[id].attention) setActivity(id, "attention", false);
  if (activity[id].stuck) setActivity(id, "stuck", false);
}

/** Drop a pane's state entirely (on unmount/close). */
export function forgetPane(id: PaneId) {
  if (activity[id]) setActivity(id, undefined as unknown as PaneActivity);
}

/** Does any pane in `ids` have a sticky signal (unseen output / bell / attention)? Drives the
 *  rail's lighter per-workspace activity dot. */
export function anyAttention(ids: Iterable<PaneId>): boolean {
  for (const id of ids) {
    const a = activity[id];
    if (a && (a.unseen || a.bell || a.attention)) return true;
  }
  return false;
}

/** Does any pane in `ids` "need you" — the sticky attention flag (busy→idle finish or
 *  `loom attention`) or the derived idle/stuck flag? Drives the rail's amber border. */
export function anyNeedsAttention(ids: Iterable<PaneId>): boolean {
  for (const id of ids) {
    const a = activity[id];
    if (a && (a.attention || a.stuck)) return true;
  }
  return false;
}

/** How many panes in `ids` are raising a "needs you" signal (attention or idle/stuck). Drives the
 *  rail's amber count pill — the group tells you *how many* want you, not just that one does. */
export function countNeedsAttention(ids: Iterable<PaneId>): number {
  let n = 0;
  for (const id of ids) {
    const a = activity[id];
    if (a && (a.attention || a.stuck)) n++;
  }
  return n;
}

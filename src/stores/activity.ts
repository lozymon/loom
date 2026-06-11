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
//     looking) or explicitly by a process inside the pane via `th attention` (ADR-0007). Like
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
}

const BLANK: PaneActivity = { unseen: false, bell: false, busy: null, attention: false };

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

/** Raise a pane's sticky attention flag (busy→idle transition, or `th attention`). Returns true
 *  only when it was newly raised (was clear before) — callers use that to fire a one-shot OS
 *  notification without re-notifying a pane that's already flagged. */
export function noteAttention(id: PaneId): boolean {
  ensure(id);
  if (activity[id].attention) return false;
  setActivity(id, "attention", true);
  return true;
}

/** Clear a pane's attention flag explicitly (`th attention --clear`). */
export function clearAttention(id: PaneId) {
  if (activity[id]?.attention) setActivity(id, "attention", false);
}

/** The user looked at the pane — clear its sticky unseen/bell/attention signals. */
export function seePane(id: PaneId) {
  if (!activity[id]) return;
  if (activity[id].unseen) setActivity(id, "unseen", false);
  if (activity[id].bell) setActivity(id, "bell", false);
  if (activity[id].attention) setActivity(id, "attention", false);
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

/** Does any pane in `ids` have the strict "needs you" attention flag (busy→idle finish or
 *  `th attention`)? Drives the rail's amber border — not raised by mere background output. */
export function anyNeedsAttention(ids: Iterable<PaneId>): boolean {
  for (const id of ids) {
    const a = activity[id];
    if (a && a.attention) return true;
  }
  return false;
}

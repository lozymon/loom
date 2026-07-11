// A live-pane directory: maps each mounted pane's PaneId to a small handle the broadcast
// router uses to write into its PTY. Terminals register/unregister themselves here on
// mount/cleanup; nobody else touches a PtyHandle.
//
// This keeps PaneId (tree identity) → PTY-write decoupled from the component tree, so the
// broadcast bar can reach every live pane without prop-drilling handles down the layout.
// Plain module state (not a Solid store) — membership is imperative, not reactive.

import type { PaneId, PtyHandle } from "../ipc/protocol";

export interface PaneEntry {
  /** Write raw text into the pane's PTY. No-op if the child has exited. */
  write: (data: string) => void;
  /** Whether the PTY is currently live (spawned, not yet exited). */
  isLive: () => boolean;
  /** The shell's live working directory, or null if dead/unavailable (Source Control). */
  cwd: () => Promise<string | null>;
  /** The last `lines` rows of the pane's scrollback as plain text (`loom read`). */
  read: (lines: number) => string;
  /** The pane's live PTY handle, or null before first spawn / after the child exits. Read only to
   *  hand a running PTY across a cross-workspace move (the pane's Terminal remounts, so the handle
   *  must be stashed for the new mount to rebind instead of respawn). See stores/workspace move ops. */
  handle: () => PtyHandle | null;
}

const registry = new Map<PaneId, PaneEntry>();

export function registerPane(id: PaneId, entry: PaneEntry): void {
  registry.set(id, entry);
}

export function unregisterPane(id: PaneId): void {
  registry.delete(id);
}

/** How many of `ids` are registered and currently live (the real broadcast reach). */
export function countLive(ids: Iterable<PaneId>): number {
  let n = 0;
  for (const id of ids) {
    const entry = registry.get(id);
    if (entry?.isLive()) n++;
  }
  return n;
}

/** The live working directory of pane `id`, or null if it isn't registered/live. */
export function paneCwd(id: PaneId): Promise<string | null> {
  const entry = registry.get(id);
  return entry ? entry.cwd() : Promise.resolve(null);
}

/** The last `lines` rows of pane `id`'s scrollback, or null if it isn't registered. */
export function readPane(id: PaneId, lines: number): string | null {
  const entry = registry.get(id);
  return entry ? entry.read(lines) : null;
}

/** The live PTY handle of pane `id`, or null if it isn't registered / has no live child. Used by the
 *  cross-workspace move to hand the running PTY across the pane's unavoidable Terminal remount. */
export function paneHandle(id: PaneId): PtyHandle | null {
  return registry.get(id)?.handle() ?? null;
}

/** Write `data` to every live pane in `ids`; returns how many actually received it. */
export function writeToPanes(ids: Iterable<PaneId>, data: string): number {
  let n = 0;
  for (const id of ids) {
    const entry = registry.get(id);
    if (entry?.isLive()) {
      entry.write(data);
      n++;
    }
  }
  return n;
}

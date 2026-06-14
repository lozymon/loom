// Pre-flight check for a pane launch command: is its program actually installed / on PATH?
//
// A pane runs `$SHELL -lc "<command>"` (ADR-0004), so a missing program (e.g. picking GitHub
// Copilot CLI on a machine without it) doesn't fail the spawn — it prints "command not found",
// exits 127, and leaves a Dead pane. That reads as a crash. The wizard uses this to warn up
// front, and the Terminal's dead-pane overlay uses the same idea after the fact.
//
// Results are cached per command string for the session: availability rarely changes mid-run,
// and the check spawns a (login) shell, so we never want to re-run it on every render. The
// check resolves through the real login shell, so PATH parity with an actual pane holds.

import { invoke } from "@tauri-apps/api/core";
import { Cmd } from "../ipc/protocol";
import { settings } from "../stores/settings";

const cache = new Map<string, Promise<boolean>>();

/**
 * Whether `command`'s program would resolve in a launched pane. Empty/blank commands are plain
 * shells → always available. Errors resolve to `true` (advisory only — never block a launch).
 */
export function checkCommandAvailable(command: string): Promise<boolean> {
  const key = command.trim();
  if (!key) return Promise.resolve(true);
  let p = cache.get(key);
  if (!p) {
    p = invoke<boolean>(Cmd.checkCommand, {
      command: key,
      shell: settings.defaultShell || null,
    }).catch(() => true);
    cache.set(key, p);
  }
  return p;
}

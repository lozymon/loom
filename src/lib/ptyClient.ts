// Thin client over the Rust PTY commands. Callers talk to this, never to `invoke` directly,
// so the output transport (base64 Channel today; raw bytes / WebSocket later per ADR-0003)
// can change without touching components. Names/types come from ../ipc/protocol.
//
// These functions deal in {@link PtyHandle} — the id Rust assigns to a live PTY — not the
// frontend PaneId. A pane component spawns, then keeps its handle to write/resize/kill.

import { invoke, Channel } from "@tauri-apps/api/core";
import { Cmd, type PtyHandle, type ExitCode } from "../ipc/protocol";

export type PtyOutput = (bytes: Uint8Array) => void;
export type PtyExit = (code: ExitCode) => void;

/** Decode a base64 string (M0 transport) into bytes for xterm. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SpawnOpts {
  cols: number;
  rows: number;
  /** Run `<shell> -lc "<command>"`; omit for a plain interactive login shell. */
  command?: string;
  /** Working directory; falls back to $HOME if missing. */
  cwd?: string;
  /** Shell binary to launch; omit to use the OS `$SHELL` (then bash/sh). */
  shell?: string;
  /** Pane display name, exported to the child as `TERMHAUS_PANE` (ADR-0007). */
  name?: string;
  /** Absolute file path to append this pane's raw output to (opt-in session logging). */
  logPath?: string;
}

/**
 * Spawn a PTY and stream its output to `onOutput`. `onExit` fires once when the child
 * dies (on its own or via {@link killPty}). Resolves with the live PtyHandle.
 */
export async function spawnPty(
  opts: SpawnOpts,
  onOutput: PtyOutput,
  onExit: PtyExit,
): Promise<PtyHandle> {
  const output = new Channel<string>();
  output.onmessage = (b64) => onOutput(b64ToBytes(b64));
  const exit = new Channel<ExitCode>();
  exit.onmessage = (code) => onExit(code);
  return invoke<PtyHandle>(Cmd.spawn, {
    cols: opts.cols,
    rows: opts.rows,
    command: opts.command ?? null,
    cwd: opts.cwd ?? null,
    shell: opts.shell ?? null,
    name: opts.name ?? null,
    logPath: opts.logPath ?? null,
    onOutput: output,
    onExit: exit,
  });
}

/** Forward keystrokes (UTF-8 text) into the PTY. */
export function writePty(handle: PtyHandle, data: string): Promise<void> {
  return invoke(Cmd.write, { id: handle, data });
}

/** Tell the PTY its new dimensions after a fit/resize. */
export function resizePty(handle: PtyHandle, cols: number, rows: number): Promise<void> {
  return invoke(Cmd.resize, { id: handle, cols, rows });
}

/** Kill the PTY's child process. Idempotent on an already-dead PTY. */
export function killPty(handle: PtyHandle): Promise<void> {
  return invoke(Cmd.kill, { id: handle });
}

/** The shell's live working directory (`/proc/<pid>/cwd`), or null if unavailable. */
export function cwdPty(handle: PtyHandle): Promise<string | null> {
  return invoke<string | null>(Cmd.cwd, { id: handle });
}

/**
 * Whether the pane is running a foreground command (true) vs sitting at the shell prompt
 * (false); null when unknown. Read from the PTY's foreground process group — metadata, not
 * pane output (ADR-0001 carve-out, same as {@link cwdPty}).
 */
export function busyPty(handle: PtyHandle): Promise<boolean | null> {
  return invoke<boolean | null>(Cmd.busy, { id: handle });
}

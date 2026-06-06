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
  /** Run `$SHELL -lc "<command>"`; omit for a plain interactive login shell. */
  command?: string;
  /** Working directory; falls back to $HOME if missing. */
  cwd?: string;
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

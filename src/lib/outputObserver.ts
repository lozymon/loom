// The ADR-0011 heuristic output-observer — pure core.
//
// ADR-0011 authorized a third, lowest-authority awareness tier: a *heuristic* signal derived from a
// pane's output by a **separate, opt-in, TypeScript** observer of the bytes xterm already holds, and
// **always labeled a guess**. This module is that observer's pure heart — the reusable substrate its
// consumers read (the status/"needs-you" floor now; command blocks / a cost estimate later). The
// four rules it exists to honour:
//
//   1. The engine stays byte-opaque. Nothing here runs in Rust; `pty.rs` never grows a parser. These
//      are plain string functions over text the frontend already decoded to render.
//   2. It is a TS consumer of bytes the frontend already has (fed from Terminal's onOutput tap).
//   3. Pushed always beats scraped. This module produces a *candidate*; `looksWaiting` refuses the
//      moment a pushed/kernel fact exists (hasPushedSignal / busy), so a scrape never overrides truth.
//   4. It is labeled heuristic. This file only computes the guess; callers render it distinctly.
//
// Statefulness (the rolling tail + UTF-8 stream decoding) lives in stores/heuristics.ts; the
// content judgements — "is this tail prompt-shaped", "does it look like it's waiting" — are the pure,
// unit-tested functions here, mirroring lib/idle.ts's isPaneStuck.

import { stripAnsi } from "./ansi";

/** Cap on the rolling per-pane tail. A prompt lives on the last line or two; a few KB is plenty and
 *  keeps `slice`/`stripAnsi` cheap even under a flood. */
export const TAIL_CAP = 4096;

/** Minimum silence after a prompt-shaped line before we trust the guess, so a prompt still actively
 *  streaming (or a `?` mid-render) isn't flagged. Much shorter than idleStuckSeconds (§1b): this is
 *  "it printed a question and went quiet", not "a long job stalled". */
export const HEURISTIC_DWELL_MS = 4000;

/** Append freshly-decoded text to a bounded tail. Concatenate *then* trim so an ANSI escape or a
 *  prompt straddling a chunk boundary is still whole when inspected (UTF-8 rune splits are handled
 *  upstream by a streaming TextDecoder). Pure. */
export function appendTail(prev: string, chunk: string, cap: number = TAIL_CAP): string {
  const next = prev + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** The last non-blank visible line of a tail: ANSI stripped, trailing blank/whitespace-only lines
 *  dropped, right-trimmed. "" when the tail is empty/all blank. This is what a prompt would be on. */
export function lastLine(tail: string): string {
  const lines = stripAnsi(tail).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, "");
    if (line.trim() !== "") return line;
  }
  return "";
}

// Conservative prompt shapes. False negatives are free (degrade to "no heuristic signal"); false
// positives are the whole cost of this tier, so keep the set tight and anchored at end-of-line.
const PROMPT_PATTERNS: RegExp[] = [
  /\?\s*$/, //                                             ends with a question mark
  /\((?:y\/n|yes\/no|y\/n\/a|y\/n\/q)\)\s*[:?]?\s*$/i, //  (y/n) style choice
  /\[(?:y\/n|yes\/no|y|n)\]\s*[:?]?\s*$/i, //              [Y/n] style choice
  /\b(?:press|hit)\s+(?:enter|return|any key)\b/i, //      "Press Enter to continue"
  /\b(?:do you want|would you like)\b/i, //                "Do you want to …"
  /\b(?:continue|proceed|overwrite|replace|retry|confirm|accept|allow|approve|abort)\b\s*\??\s*[:?]?\s*$/i,
  /[❯➜»]\s*$/, //                                          agent/REPL prompt glyphs
];

/** Does the tail's last visible line look like a prompt awaiting the user? Conservative by design —
 *  a guess, never a claim. Pure. */
export function promptShaped(tail: string): boolean {
  const line = lastLine(tail);
  if (line === "") return false;
  return PROMPT_PATTERNS.some((re) => re.test(line));
}

export interface WaitingInputs {
  /** This pane is a live, opt-in (hookless) agent — the registry + kill-switch gate already passed. */
  runningAgent: boolean;
  /** The tail's last visible line is prompt-shaped (the content signal this tier uniquely reads). */
  promptShaped: boolean;
  /** now - lastOutputAt (ms); how long the pane has been silent since that prompt-shaped line. */
  idleMs: number;
  /** Dwell to require before trusting the guess (HEURISTIC_DWELL_MS); <= 0 disables the dwell gate. */
  thresholdMs: number;
  /** A truthier source already speaks for this pane — a live pushed Session/Task, or a pushed
   *  attention/status flag. Rule 3: when true, the heuristic yields entirely. */
  hasPushedSignal: boolean;
}

/**
 * Does this pane *look like* it's waiting on the user? The lowest-authority verdict: a running,
 * opted-in agent that printed a prompt-shaped line and then went quiet — with no *pushed* fact to
 * defer to. Returns false the instant a pushed signal exists (rule 3).
 *
 * We deliberately do NOT gate on the kernel `busy` flag. A CLI agent blocked on a prompt is still
 * the live foreground process, so `busy` reads true exactly when it's waiting — gating on it is the
 * same trap lib/idle.ts's §1b detector documents avoiding. And per ADR-0011's own logic, "a command
 * is running" doesn't distinguish *working* from *waiting* — closing that gap is the whole point of
 * this tier. The dwell below (a prompt-shaped line, then silence) is what separates the two; a
 * genuinely-working pane keeps emitting, so its idleMs never reaches the threshold. Pure; `now` is
 * folded into `idleMs` by the caller so this stays testable, exactly like isPaneStuck.
 */
export function looksWaiting(p: WaitingInputs): boolean {
  if (!p.runningAgent) return false;
  if (p.hasPushedSignal) return false; // pushed/rich fact owns this pane — never override it
  if (!p.promptShaped) return false; //   the content signal is the whole point of this tier
  if (p.thresholdMs > 0 && p.idleMs < p.thresholdMs) return false; // let the prompt settle first
  return true;
}

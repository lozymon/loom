// ADR-0011 heuristic output-observer — the stateful per-pane layer around lib/outputObserver's pure
// core. It owns the rolling tail and the streaming UTF-8 decoder for each observed pane. Deliberately
// a plain Map, NOT a reactive store: it's fed on the byte hot path (Terminal's onOutput), and we
// don't want a store write — or any reactivity — per chunk under a flood. The *derived* verdict
// (heuristicAttention) is what lands in the reactive activity store, recomputed on the slow metadata
// poll, not here.
//
// Only opt-in panes are ever fed (Terminal gates on agentUsesHeuristics + the kill-switch), so this
// map only ever holds bytes for hookless agent kinds — never Claude, never a plain shell. Rule 1/2
// of ADR-0011: pure TS over bytes the frontend already decoded to render; nothing reaches Rust.

import type { PaneId } from "../ipc/protocol";
import { appendTail, promptShaped, TAIL_CAP } from "../lib/outputObserver";

interface Observed {
  /** Streaming decoder so a multi-byte UTF-8 rune split across chunks isn't mangled. */
  dec: TextDecoder;
  /** Bounded, ANSI-inclusive decoded tail (stripped only when inspected). */
  tail: string;
}

const observed = new Map<PaneId, Observed>();

/** Feed a fresh output chunk for a pane. Called from Terminal.onOutput, but only for opt-in agent
 *  panes (the registry + kill-switch gate lives at the call site). Cheap: decode + string concat +
 *  cap; no reactivity. */
export function observeBytes(paneId: PaneId, bytes: Uint8Array): void {
  let o = observed.get(paneId);
  if (!o) {
    o = { dec: new TextDecoder("utf-8", { fatal: false }), tail: "" };
    observed.set(paneId, o);
  }
  const text = o.dec.decode(bytes, { stream: true });
  if (text) o.tail = appendTail(o.tail, text, TAIL_CAP);
}

/** The pane's current decoded tail ("" if never observed). */
export function paneTail(paneId: PaneId): string {
  return observed.get(paneId)?.tail ?? "";
}

/** Does this pane's tail currently look like a prompt awaiting the user? Convenience over
 *  paneTail + promptShaped, evaluated on the slow poll — the content read this tier exists for. */
export function paneTailPromptShaped(paneId: PaneId): boolean {
  const o = observed.get(paneId);
  return o ? promptShaped(o.tail) : false;
}

/** Forget a pane's observed output — on respawn (a fresh run's prompt shouldn't inherit the old
 *  tail), on exit, and on pane close. Idempotent. */
export function resetPaneObserver(paneId: PaneId): void {
  observed.delete(paneId);
}

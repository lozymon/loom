// Per-pane input holds ("gates") — a standing operator gate on a pane's *inbound bus input*
// (AGENTIC-ENHANCEMENTS §4a). While a pane is gated, any bus-delivered input to it (`loom send`,
// `loom broadcast`, and their MCP equivalents) requires a human OK before it lands, so one bad
// broadcast can't drive a sensitive pane (the prod-touching one, a live migration) without a
// deliberate confirm. A sibling of the file claims (stores/claims.ts): same agent-pushed,
// opacity-safe `{ by, at }` shape, but the gate is on a *pane*, not a path — so it's keyed by the
// globally-unique PaneId, and it gates delivery rather than an advisory lock.
//
// Distinct from the two adjacent guardrails: §4b (stores/settings confirmDestructiveBroadcast)
// gates only *destructive* commands on *any* pane; the claim `held` state (stores/claims.ts) gates
// a *file path*. This is a general, standing, per-pane stdin gate.
//
// Ephemeral (runtime coordination, not persisted — same category as claims/activity): a gate is
// dropped when its pane closes (forgetGate, called from closePane). Keyed holds[paneId] = { by, at }.

import { createStore } from "solid-js/store";
import type { PaneId } from "../ipc/protocol";

export interface InputHold {
  /** Display name of the pane (or agent) that placed the gate. */
  by: string;
  /** Epoch-ms the gate was placed. */
  at: number;
  /** Optional operator note on why the pane is gated (shown in the Fleet panel / confirm). */
  reason?: string;
}

/** One gated pane, for `gate.list` output. */
export interface HoldListing extends InputHold {
  paneId: PaneId;
}

const [holds, setHolds] = createStore<Record<PaneId, InputHold>>({});

/** Reactive read-only view — read `holds[id]?.by` etc. (undefined = not gated). */
export { holds };

/** Gate pane `id`'s inbound bus input. Idempotent: re-gating keeps the original timestamp/holder
 *  but refreshes the reason if a new one is given. Returns whether the gate was newly placed. */
export function gatePane(id: PaneId, by: string, reason?: string): { fresh: boolean } {
  const cur = holds[id];
  if (cur) {
    if (reason !== undefined && reason !== cur.reason) setHolds(id, "reason", reason || undefined);
    return { fresh: false };
  }
  setHolds(id, { by, at: Date.now(), reason: reason || undefined });
  return { fresh: true };
}

/** Drop pane `id`'s input gate. Returns whether one was actually removed. */
export function releaseGate(id: PaneId): boolean {
  if (!holds[id]) return false;
  setHolds(id, undefined as unknown as InputHold);
  return true;
}

/** Is pane `id` currently gated? Read by the bus router before delivering input. */
export function isGated(id: PaneId): boolean {
  return holds[id] !== undefined;
}

/** The gate on pane `id`, or undefined. */
export function getGate(id: PaneId): InputHold | undefined {
  return holds[id];
}

/** Every gated pane, oldest-first (stable for list output). Pane names are looked up by the caller
 *  (the store deliberately doesn't know the layout); this returns ids + gate metadata. */
export function listGates(): HoldListing[] {
  return (Object.keys(holds) as unknown as PaneId[])
    .map((id) => ({ paneId: Number(id) as PaneId, ...holds[id] }))
    .sort((a, b) => a.at - b.at);
}

/** Drop a pane's gate when it closes (called from closePane), so a gate never outlives its pane. */
export function forgetGate(id: PaneId): void {
  if (holds[id]) setHolds(id, undefined as unknown as InputHold);
}

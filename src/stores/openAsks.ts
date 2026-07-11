// Reactive mirror of the ask/reply registry's *open* asks (AGENTIC-ENHANCEMENTS §2a/§2e follow-up).
// The registry (lib/askRegistry.ts) is a framework-free RPC engine keyed by correlation id; this
// store adapts its open set into SolidJS reactivity so the Fleet panel can render a live list of
// questions one agent has put to another and is still waiting on — the last piece of coordination
// state that wasn't visible in the panel.
//
// Opacity-safe (ADR-0001): an ask is created by the `loom ask` bus op and answered by an agent-
// pushed `loom reply`; nothing here scrapes pane output. The list is fleet-wide, not workspace-
// scoped — an ask is keyed by pane *name* and can legitimately cross workspaces, and the registry
// has no workspace notion — so the panel shows every open ask regardless of the active workspace.

import { createStore } from "solid-js/store";
import { listOpenAsks, subscribeAsks, cancelAsk, type OpenAsk } from "../lib/askRegistry";

const [openAsks, setOpenAsks] = createStore<OpenAsk[]>(listOpenAsks());

// Seed already covers asks created before this module loaded; the subscription keeps it live for
// every later create/reply/expire/cancel. The registry hands us the full open set each time, so we
// replace wholesale — the list is small and transient, so per-row keyed diffing isn't worth it.
// Module-level subscription (never torn down) — the store is a process singleton like the other
// coordination stores.
subscribeAsks((open) => setOpenAsks(open));

/** Reactive read-only view — the currently-open asks, oldest-first. */
export { openAsks };

/** Operator dismiss for a stuck ask: retire it in the registry (any parked `loom ask` poll resolves
 *  `unknown`). Mirrors the release actions on the panel's claims/gates sections. */
export function dismissAsk(id: number): void {
  cancelAsk(id);
}

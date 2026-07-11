// Bus-command audit timeline (docs/FEATURES.md). Every inter-pane control request
// (ADR-0007) flows through paneControl.dispatch; we append a compact record here so an operator can
// see the cross-pane command stream — who drove whom, and whether it landed — on one timeline.
//
// A bounded ring (newest last), in-memory and ephemeral: the durable per-session log (ADR-0009,
// SessionLogViewer's Logs tab) is a separate thing. This is the live audit feed, opacity-safe — it
// records the *commands* Loom relays, never pane output.

import { createStore } from "solid-js/store";
import type { ControlRequest } from "../ipc/protocol";

export interface AuditEntry {
  id: number;
  ts: number;
  op: string;
  /** The pane/role/workspace/key the command acted on, when the op carries one. */
  target?: string;
  ok: boolean;
  /** Short summary — the error on failure, else absent. */
  detail?: string;
}

const CAP = 500;
let seq = 0;
const [audit, setAudit] = createStore<{ entries: AuditEntry[] }>({ entries: [] });

/** Reactive read-only view — read `audit.entries`. */
export { audit };

/** The most-relevant identifier an op touches, for the timeline's "target" column. */
function targetOf(req: ControlRequest): string | undefined {
  const r = req as unknown as Record<string, unknown>;
  for (const k of ["target", "workspace", "name", "path", "key", "id"] as const) {
    if (typeof r[k] === "string") return r[k] as string;
  }
  return undefined;
}

/** Append one relayed command to the timeline (called from paneControl after each dispatch). */
export function recordAudit(req: ControlRequest, ok: boolean, error?: string): void {
  const entry: AuditEntry = { id: ++seq, ts: Date.now(), op: req.op, target: targetOf(req), ok, detail: error };
  const kept = audit.entries.length >= CAP ? audit.entries.slice(audit.entries.length - CAP + 1) : audit.entries.slice();
  kept.push(entry);
  setAudit("entries", kept);
}

/** Drop the whole timeline (a UI "clear" affordance). */
export function clearAudit(): void {
  setAudit("entries", []);
}

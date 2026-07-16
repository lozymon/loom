// Bus-command audit timeline (docs/FEATURES.md; ADR-0012 rule 4). Every inter-pane control request
// (ADR-0007) flows through paneControl.dispatch; we append a compact record here so an operator can
// see the cross-pane command stream — who drove whom, from where, and whether it landed — on one
// timeline.
//
// Two layers, deliberately:
//  - a bounded in-memory ring (newest last) is the live feed the UI renders; and
//  - a durable mirror in sessions.db (lib/auditClient.ts → sessionlog.rs `audit` table) is the
//    *after-the-fact* record. The ring alone (500 entries, cleared on restart) is what ADR-0012
//    rule 4 calls out as insufficient: a phone-driven `broadcast` at lunch must be reconstructable
//    later, not just visible for the next 500 commands. Persistence is what makes rule 4 real.
//
// Opacity-safe: it records the *commands* Loom relays, never pane output.

import { createStore } from "solid-js/store";
import type { ControlRequest, Origin } from "../ipc/protocol";
import { saveAudit, recentAudit, clearAuditLog } from "../lib/auditClient";

export interface AuditEntry {
  /** Ephemeral list key (a per-run sequence). NOT the durable DB id — the DB autoincrements its own. */
  id: number;
  ts: number;
  op: string;
  /** The pane/role/workspace/key the command acted on, when the op carries one. */
  target?: string;
  ok: boolean;
  /** Short summary — the error on failure, else absent. */
  detail?: string;
  /** Where the command came from (ADR-0012 rule 4). `local` today; `device:*` arrives with P2. */
  origin: Origin;
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

/** Push one entry onto the bounded ring (newest last, oldest dropped past CAP). */
function pushEntry(entry: AuditEntry): void {
  const kept =
    audit.entries.length >= CAP
      ? audit.entries.slice(audit.entries.length - CAP + 1)
      : audit.entries.slice();
  kept.push(entry);
  setAudit("entries", kept);
}

/**
 * Append one relayed command to the timeline (called from paneControl after each dispatch) and
 * mirror it to the durable trail. `origin` defaults to `local` — every caller is local until the
 * remote envelope (P2) tags `device:*`. The persist is fire-and-forget: a DB failure must never
 * disrupt the live feed.
 */
export function recordAudit(
  req: ControlRequest,
  ok: boolean,
  error?: string,
  origin: Origin = "local",
): void {
  const entry: AuditEntry = {
    id: ++seq,
    ts: Date.now(),
    op: req.op,
    target: targetOf(req),
    ok,
    detail: error,
    origin,
  };
  pushEntry(entry);
  void saveAudit({
    ts: entry.ts,
    op: entry.op,
    target: entry.target,
    ok: entry.ok,
    detail: entry.detail,
    origin: entry.origin,
  }).catch(() => {});
}

/**
 * Seed the ring from the durable trail at startup, so the timeline survives a restart (rule 4's
 * "after-the-fact record"). Best-effort: on failure the live feed simply starts empty. Only seeds
 * when the ring is still empty, so it never clobbers commands recorded during startup.
 */
export async function loadAuditHistory(limit = CAP): Promise<void> {
  try {
    const rows = await recentAudit(limit);
    if (audit.entries.length > 0) return;
    setAudit(
      "entries",
      rows.map((r) => ({
        id: ++seq,
        ts: r.ts,
        op: r.op,
        target: r.target ?? undefined,
        ok: r.ok,
        detail: r.detail ?? undefined,
        origin: r.origin,
      })),
    );
  } catch {
    // history DB unavailable — the live feed still works this run
  }
}

/** Drop the whole timeline — the ring *and* the durable record, so a restart doesn't resurrect what
 *  the operator cleared. */
export function clearAudit(): void {
  setAudit("entries", []);
  void clearAuditLog().catch(() => {});
}

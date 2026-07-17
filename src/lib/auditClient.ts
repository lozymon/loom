// Client for the durable bus-command audit trail (ADR-0012 rule 4) — thin invoke wrappers over the
// Rust SQLite commands (src-tauri/src/sessionlog.rs, `audit` table in the shared sessions.db). The
// in-memory ring (stores/audit.ts) stays the live source of truth for the timeline view; these
// mirror it to disk so a phone-driven command is attributable *after the fact*, not only live.
//
// All writes are best-effort and fire-and-forget from the store's perspective — a failed persist
// must never disrupt the live UI (mirrors sessionLogClient).

import { invoke } from "@tauri-apps/api/core";
import type { Origin } from "../ipc/protocol";

/** One row to persist. No id: the DB autoincrements its own (the ring's ids are a per-run seq). */
export interface AuditRow {
  ts: number;
  op: string;
  target?: string;
  ok: boolean;
  detail?: string;
  origin: Origin;
}

/** One durable row for hydration/display (mirrors the Rust `AuditHit`, minus the list id). */
export interface AuditHit {
  ts: number;
  op: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
  origin: Origin;
}

export const saveAudit = (entry: AuditRow): Promise<void> =>
  invoke<void>("audit_log_save", { entry });

/** Recent audit rows, oldest-first (ready to seed the ring in timeline order). */
export const recentAudit = (limit?: number): Promise<AuditHit[]> =>
  invoke<AuditHit[]>("audit_log_recent", { limit });

/** Trim the durable trail to a bounded window (ADR-0012 rule 4); a cap of 0 disables that bound. */
export const pruneAudit = (maxAgeDays: number, maxRows: number): Promise<void> =>
  invoke<void>("audit_log_prune", { maxAgeDays, maxRows });

/** Wipe the durable trail (paired with the ring's clear, so a restart won't resurrect it). */
export const clearAuditLog = (): Promise<void> => invoke<void>("audit_log_clear");

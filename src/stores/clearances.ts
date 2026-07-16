// Clearances — a bus command parked pending a human go/no-go (ADR-0012 rule 3.4; model spec in
// docs/roadmap/plans/02-mobile-remote.md "P0b design"). This replaces the three synchronous
// `window.confirm` guardrails in lib/paneControl.ts, which were a live defect: `confirm` blocks
// the WebKitGTK webview thread, so an agent tripping a guardrail on an unattended laptop froze
// *every* Pane's rendering until someone walked over — while control.rs gave up on the caller
// after REPLY_TIMEOUT (10s) and told it the app had timed out. The eventual click then spawned a
// pane nobody was waiting for and the asking agent never learned of.
//
// Distinct from ADR-0008's Approval (stores/sessions.ts): an **Agent** raises an Approval about
// *its own work*; **Loom** raises a Clearance about *a command*. Same shape, different entities
// (CONTEXT.md) — do not merge the two lists.
//
// Ephemeral, like inputHolds/claims — and ADR-0002 is *why*, not just convention: quitting kills
// every PTY, so every caller dies with the app. A persisted Clearance would be one whose caller is
// definitionally gone, and which must therefore never execute. Persisting it would be the bug.

import { createStore } from "solid-js/store";
import type { PaneId } from "../ipc/protocol";

/** Which guardrail parked the command. */
export type ClearanceKind = "spawn" | "destructive-broadcast" | "gated-input";

/**
 * How a Clearance ended. Four, not two — the distinction is load-bearing:
 * - `approved` / `denied` — the operator decided. Audit records a decision.
 * - `withdrawn` — the caller stopped waiting (socket closed, CLI killed, Pane died). **Nobody
 *   decided anything**, so this must not be recorded as a denial or the audit trail (ADR-0012
 *   rule 4) fills with operator choices that never happened.
 * - `expired` — a default-deny deadline elapsed. Only remote-origin (Flow A) commands set one;
 *   local commands have no wall clock, since their lifetime is the caller's (rule 3.4).
 */
export type ClearanceOutcome = "approved" | "denied" | "withdrawn" | "expired";

/** What a caller asks for. `ttlMs` omitted = no deadline (the local/Flow B case). */
export interface ClearanceSpec {
  kind: ClearanceKind;
  /** One-line question, prerendered for display ("A pane wants to open a terminal and run:"). */
  summary: string;
  /** The command or input text under review. */
  detail?: string;
  /** A warning the operator must weigh (e.g. panes sharing a worktree) — rendered with weight. */
  note?: string;
  /** Panes the command would touch, when the guardrail knows them. */
  targets?: PaneId[];
  /** Milliseconds until default-deny. Omit for none. */
  ttlMs?: number;
}

/**
 * One parked command awaiting a decision.
 *
 * Deliberately no `asker`: the bus attaches **no caller identity** (ADR-0007 — "Rust attaches no
 * caller identity (it's a pure relay)"; `$LOOM_PANE` is resolved client-side into `target`). Loom
 * genuinely cannot know which Pane called, which is why the guardrail text this replaces said
 * "*Another* pane wants to…". Naming a caller here would be fiction, or worse — a self-asserted
 * name a poisoned agent could forge.
 */
export interface Clearance {
  id: number;
  kind: ClearanceKind;
  summary: string;
  detail: string;
  note?: string;
  targets: PaneId[];
  /** Epoch-ms the command was parked. */
  at: number;
  /** Epoch-ms default-deny deadline, or null for none. */
  expiresAt: number | null;
}

const [clearances, setClearances] = createStore<Record<number, Clearance>>({});

// The continuation and its timer are held *outside* the store — the same split control.rs makes
// between `PendingReplies`' data and its channel. A resolver is not reactive state and has no
// business in a Solid proxy.
const resolvers = new Map<number, (o: ClearanceOutcome) => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

/** Reactive read-only view — `clearances[id]`, or iterate with {@link listClearances}. */
export { clearances };

/**
 * Park a command and wait for a decision. The returned promise settles exactly once; the caller
 * (paneControl.dispatch) executes only on `approved`.
 *
 * `onPark` fires synchronously with the new Clearance's id the moment it is parked — the seam the
 * bus layer uses to (a) tell Rust to lift the reply deadline (`pane_cmd_parked`) and (b) remember
 * which Clearance a `reqId` maps to, so an abort can withdraw the right one.
 */
export function requestClearance(
  spec: ClearanceSpec,
  onPark?: (clearanceId: number) => void,
): Promise<ClearanceOutcome> {
  const id = ++seq;
  const at = Date.now();
  const expiresAt = spec.ttlMs != null ? at + spec.ttlMs : null;
  setClearances(id, {
    id,
    kind: spec.kind,
    summary: spec.summary,
    detail: spec.detail ?? "",
    note: spec.note,
    targets: spec.targets ?? [],
    at,
    expiresAt,
  });
  const promise = new Promise<ClearanceOutcome>((resolve) => {
    resolvers.set(id, resolve);
    if (spec.ttlMs != null) timers.set(id, setTimeout(() => settle(id, "expired"), spec.ttlMs));
  });
  onPark?.(id);
  return promise;
}

/** Settle once and clean up. Returns false if `id` was already settled (a late/duplicate answer). */
function settle(id: number, outcome: ClearanceOutcome): boolean {
  const resolve = resolvers.get(id);
  if (!resolve) return false;
  resolvers.delete(id);
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
  setClearances(id, undefined as unknown as Clearance);
  resolve(outcome);
  return true;
}

/** The operator decided. Returns whether this call was the one that settled it. */
export function resolveClearance(id: number, approved: boolean): boolean {
  return settle(id, approved ? "approved" : "denied");
}

/**
 * The caller stopped waiting — withdraw without deciding. Driven by `loom://pane-cmd-abort`, which
 * Rust emits when the caller's socket closes. This is the invariant that keeps the old bug dead:
 * **a Clearance must never outlive its caller**, so Approve becomes unreachable rather than firing
 * a command nobody awaits.
 */
export function withdrawClearance(id: number): boolean {
  return settle(id, "withdrawn");
}

/** Every parked Clearance, oldest-first (stable for list rendering). */
export function listClearances(): Clearance[] {
  return (Object.keys(clearances) as unknown as number[])
    .map((id) => clearances[Number(id)])
    .filter((c): c is Clearance => c !== undefined)
    .sort((a, b) => a.at - b.at);
}

/** How many commands are waiting on a human (badge count). */
export function pendingClearanceCount(): number {
  return Object.keys(clearances).length;
}

/** Test seam: withdraw everything and reset ids. Not used in app code. */
export function resetClearances(): void {
  for (const id of [...resolvers.keys()]) settle(id, "withdrawn");
  seq = 0;
}

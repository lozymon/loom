// File claims — cooperative, advisory locks a fleet uses so two agents don't edit the same file
// at once (docs/FEATURES.md). A sibling of the blackboard (stores/blackboard.ts):
// same per-workspace, agent-pushed, opacity-safe shape, but with claim-specific semantics —
// `claimFile` is an atomic test-and-set (fails if another pane holds the path) and `releaseFile`
// is holder-scoped (only the holder drops it, unless forced). Kept a separate store from notes so
// `note list` stays notes-only and a user's note key can't collide with a lock.
//
// Advisory only: Loom doesn't intercept filesystem writes — agents cooperate by calling `claim`
// before they edit. State is ephemeral (runtime coordination, not persisted); a workspace's claims
// are dropped when it closes. Keyed claims[workspaceId][path] = { by, at }.

import { createStore } from "solid-js/store";

export interface Claim {
  /** Display name of the pane holding the lock. */
  by: string;
  /** Epoch-ms the claim was taken. */
  at: number;
  /** A gate (ORCHESTRATION-IDEAS §3): when true, work on `path` is *held* — an agent must not
   *  proceed past it until the hold is released. Set by `holdClaim` (an operator or coordinator),
   *  cleared by `releaseFile`. A claim attempt on a held path fails so the agent blocks. */
  held?: boolean;
}

/** One path + its holder, for `claims` (list) output. */
export interface ClaimListing extends Claim {
  path: string;
}

/** Outcome of a claim attempt. `ok` means the caller now holds it (`fresh` = newly taken vs. it
 *  was already theirs); `held` means an operator has gated the path (§3) and the agent must wait;
 *  otherwise another pane holds it (`by`/`at` identify them). */
export type ClaimResult =
  | { ok: true; fresh: boolean }
  | { ok: false; held: true; by: string }
  | { ok: false; by: string; at: number };

/** Outcome of a release. `unheld` = nothing was claimed there; `other` = held by someone else and
 *  not forced (`by` names them). */
export type ReleaseResult =
  | { ok: true }
  | { ok: false; reason: "unheld" }
  | { ok: false; reason: "other"; by: string };

const [claims, setClaims] = createStore<Record<string, Record<string, Claim>>>({});

/** Reactive read-only view — read `claims[wsId]?.[path]?.by` etc. */
export { claims };

/** Atomic test-and-set: take `path` for pane `by`. Idempotent if it's already yours. A path an
 *  operator has *held* (§3) blocks the claim so the agent waits until it's released. */
export function claimFile(wsId: string, path: string, by: string): ClaimResult {
  const cur = claims[wsId]?.[path];
  if (cur?.held) return { ok: false, held: true, by: cur.by };
  if (cur && cur.by !== by) return { ok: false, by: cur.by, at: cur.at };
  if (cur) return { ok: true, fresh: false }; // already yours — leave the original timestamp
  if (!claims[wsId]) setClaims(wsId, {});
  setClaims(wsId, path, { by, at: Date.now() });
  return { ok: true, fresh: true };
}

/** Gate a path (§3): mark it *held* so a later `claimFile` blocks until `releaseFile` clears it.
 *  Creates the entry if none exists (the holder is `by`); otherwise flips the existing claim to
 *  held. Returns whether a hold was newly placed vs. already held. */
export function holdClaim(wsId: string, path: string, by: string): { ok: true; fresh: boolean } {
  const cur = claims[wsId]?.[path];
  if (cur?.held) return { ok: true, fresh: false };
  if (!claims[wsId]) setClaims(wsId, {});
  setClaims(wsId, path, cur ? { ...cur, held: true } : { by, at: Date.now(), held: true });
  return { ok: true, fresh: true };
}

/** Drop a claim. Only the holder may, unless `force` (a coordinator clearing a stale lock). */
export function releaseFile(wsId: string, path: string, by: string, force = false): ReleaseResult {
  const cur = claims[wsId]?.[path];
  if (!cur) return { ok: false, reason: "unheld" };
  if (cur.by !== by && !force) return { ok: false, reason: "other", by: cur.by };
  setClaims(wsId, path, undefined as unknown as Claim);
  return { ok: true };
}

/** All claims in a workspace, path-sorted for stable output. */
export function listClaims(wsId: string): ClaimListing[] {
  const c = claims[wsId];
  if (!c) return [];
  return Object.keys(c)
    .sort()
    .map((path) => ({ path, ...c[path] }));
}

/** Release every claim held by pane `by` in a workspace — called when that pane dies (its process
 *  exits) or closes, so an advisory lock never outlives its holder. Returns how many were dropped.
 *  (Blackboard notes are deliberately *not* cleared this way: they're shared plan state, not owned.) */
export function releaseClaimsBy(wsId: string, by: string): number {
  const c = claims[wsId];
  if (!c) return 0;
  let n = 0;
  for (const path of Object.keys(c)) {
    if (c[path].by === by) {
      setClaims(wsId, path, undefined as unknown as Claim);
      n++;
    }
  }
  return n;
}

/** Drop a whole workspace's claims (on workspace close). */
export function forgetClaims(wsId: string) {
  if (claims[wsId]) setClaims(wsId, undefined as unknown as Record<string, Claim>);
}

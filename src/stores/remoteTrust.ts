// Trust-this-device — a standing authorization that lets a paired remote Device (the phone over the
// LAN bridge, ADR-0012) run its `approve`-disposition ops (read/send) WITHOUT parking a Clearance on
// the operator each time. It's the answer to "I can't drive my fleet when I'm not at the laptop":
// the deny-by-default table (remotePolicy.ts) is UNCHANGED — this only collapses the per-op
// Confirmation (rule 3.2) into a one-time grant. `list` stays allow; everything unlisted stays deny.
//
// Opt-in and revocable. Persisted (unlike a Clearance — ADR-0002/0012 keep those ephemeral because
// the caller dies with the app; a *device* instead survives a restart, so its trust should too), and
// reset on unpair: wiping the key cuts the device off, so its trust is meaningless. After a re-pair
// the operator re-earns trust from the Clearance card. Every trusted op is still audited (rule 4).

import { createSignal } from "solid-js";
import type { Origin } from "../ipc/protocol";
import { loadState, saveState } from "../lib/persist";

const STORE_KEY = "remoteTrust";
const [trusted, setTrusted] = createSignal(false);

/** Reactive: has the operator trusted the paired device? Drives the Settings/Clearance UI. */
export const remoteTrusted = trusted;

/** Whether a request's origin bypasses the Clearance gate. Only Device origins can be trusted —
 *  `local` has full authority already and is never gated, so it's excluded here. */
export function isRemoteTrusted(origin: Origin): boolean {
  return origin !== "local" && trusted();
}

function persist() {
  void saveState(STORE_KEY, JSON.stringify({ trusted: trusted() }));
}

/** Grant standing trust to the paired device (the Clearance card's "Approve & always" action). */
export function trustRemoteDevice() {
  if (!trusted()) {
    setTrusted(true);
    persist();
  }
}

/** Revoke trust — on unpair (key wiped), or an explicit "stop trusting" from Settings. */
export function revokeRemoteTrust() {
  if (trusted()) {
    setTrusted(false);
    persist();
  }
}

/** Load persisted trust once at startup. */
export async function initRemoteTrust() {
  try {
    const raw = await loadState(STORE_KEY);
    if (raw) setTrusted(!!(JSON.parse(raw) as { trusted?: boolean }).trusted);
  } catch {
    /* default: untrusted */
  }
}

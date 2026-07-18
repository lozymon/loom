// The Clearance dock — where a bus command parked on a human decision surfaces (ADR-0012 rule 3.4;
// stores/clearances.ts). It replaces the old `window.confirm`, which blocked the webview thread and
// froze every Pane; this is non-blocking and *self-surfacing*: the operator does not open it, it
// appears bottom-right the instant a guardrail parks a command, and clears when none are pending.
//
// Distinct from the Fleet panel's Approvals (ADR-0008): an Agent raises an Approval about its own
// work; a Clearance is Loom holding a *command* pending permission. Mounted unconditionally in
// App.tsx — it renders nothing while empty.
//
// The Approve/Deny here is a real authorization boundary only for local commands (an Agent asks,
// you decide — different principals). ADR-0012 rule 3.3 notes the remote case is a Confirmation, not
// a control; that distinction lives in the ADR, not this pixel.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  listClearances,
  resolveClearance,
  type Clearance,
  type ClearanceKind,
} from "../stores/clearances";
import { trustRemoteDevice } from "../stores/remoteTrust";

const KIND_LABEL: Record<ClearanceKind, string> = {
  spawn: "New terminal",
  "destructive-broadcast": "Destructive broadcast",
  "gated-input": "Input gate",
  "remote-command": "Remote command",
};

/** Countdown seconds until default-deny, or null when there is no wall clock (the local case). */
function secondsLeft(c: Clearance, nowMs: number): number | null {
  if (c.expiresAt == null) return null;
  return Math.max(0, Math.ceil((c.expiresAt - nowMs) / 1000));
}

export default function ClearanceDock() {
  // listClearances() reads Object.keys(clearances) + each entry, so this memo re-runs whenever a
  // Clearance is parked or settles (Solid tracks store key add/remove via its ownKeys trap).
  const items = createMemo(() => listClearances());

  // A 1s clock, but only running while a timed (Flow A) Clearance is present — no idle wakeups when
  // every pending command is local (no wall clock). `now` drives the visible countdown.
  const [now, setNow] = createSignal(Date.now());
  const hasTimed = createMemo(() => items().some((c) => c.expiresAt != null));
  createEffect(() => {
    if (!hasTimed()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  return (
    <Show when={items().length > 0}>
      <div class="clearance-dock" role="region" aria-label="Commands awaiting your decision">
        <For each={items()}>
          {(c) => {
            const left = createMemo(() => secondsLeft(c, now()));
            return (
              <div class="clearance-card" data-kind={c.kind}>
                <div class="clearance-head">
                  <span class="clearance-kind">{KIND_LABEL[c.kind]}</span>
                  <Show when={left() != null}>
                    <span class="clearance-timer" title="Denies automatically">
                      {left()}s
                    </span>
                  </Show>
                </div>
                <div class="clearance-summary">{c.summary}</div>
                <Show when={c.detail}>
                  <pre class="clearance-detail">{c.detail}</pre>
                </Show>
                <Show when={c.note}>
                  <div class="clearance-note">{c.note}</div>
                </Show>
                <div class="clearance-actions">
                  <button
                    type="button"
                    class="clearance-btn deny"
                    onClick={() => resolveClearance(c.id, false)}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    class="clearance-btn approve"
                    onClick={() => resolveClearance(c.id, true)}
                  >
                    Approve once
                  </button>
                  {/* Remote (Device) commands can be trusted standing, so the paired phone drives the
                      fleet without a prompt each time — the "I'm away from the laptop" path (ADR-0012
                      trusted device). Revoke by unpairing (or in Settings → Remote). */}
                  <Show when={c.kind === "remote-command"}>
                    <button
                      type="button"
                      class="clearance-btn approve"
                      title="Approve this and stop asking for this device (until you unpair)"
                      onClick={() => {
                        trustRemoteDevice();
                        resolveClearance(c.id, true);
                      }}
                    >
                      Approve &amp; always
                    </button>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

import type { ApprovalDecision, StewardReview } from "@loom/protocol";
import { Match, Show, Switch } from "solid-js";

function pct(n: number | undefined): string {
  return n === undefined ? "" : `${Math.round(n * 100)}%`;
}

/** The Steward's part of an approval card: reviewing, its advice, or why it could not help. */
export function StewardNote(props: { review: StewardReview; onAccept?: (decision: ApprovalDecision) => void }) {
  const r = () => props.review;
  return (
    <div class="steward-note" classList={{ [`steward-${r().decision ?? r().status}`]: true }}>
      <Switch>
        <Match when={r().status === "reviewing"}>
          <span class="pulse" /> <span>Steward is reviewing…</span>
        </Match>
        <Match when={r().status === "unavailable"}>
          <span class="steward-label">Steward unavailable</span>
          <span class="muted">{r().heldBecause}</span>
        </Match>
        <Match when={r().decision === "escalate"}>
          <span class="steward-label">Steward escalated</span>
          <span>{r().reason}</span>
        </Match>
        <Match when={r().decision === "allow" || r().decision === "deny"}>
          <span class="steward-label">
            Steward recommends {r().decision} · {pct(r().confidence)} · {r().risk} risk
          </span>
          <span>{r().reason}</span>
          <Show when={r().heldBecause}>
            <span class="muted small">Not applied: {r().heldBecause}</span>
          </Show>
          <Show when={props.onAccept}>
            <button
              class="small-button"
              onClick={() =>
                props.onAccept!(r().decision === "allow" ? { type: "allow" } : { type: "deny", message: `Denied on the Steward's advice: ${r().reason}` })
              }
            >
              Accept {r().decision}
            </button>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

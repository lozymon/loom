import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { HubContext } from "../hub/store.ts";
import { useHubList } from "../hub/hubList.ts";
import { useVoice } from "../voice/controller.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * Every pending approval on every hub, oldest first. Keyboard: j and k move, a allows, d denies,
 * o opens the session, Escape closes. Keys are ignored while typing in a field.
 */
export function ApprovalsPanel(props: { onClose(): void; focus?: string | undefined }) {
  const hubList = useHubList();
  const pending = createMemo(() =>
    hubList
      .hubs()
      .flatMap((h) => Object.values(h.hub.state.approvals).map((request) => ({ request, hub: h.hub })))
      .sort((a, b) => a.request.requestedAt - b.request.requestedAt),
  );
  const [index, setIndex] = createSignal(0);
  // Opened from a notification: select that approval once it is known, or say it is gone.
  const [missing, setMissing] = createSignal(false);
  let focused = false;
  createEffect(() => {
    if (!props.focus || focused) return;
    const at = pending().findIndex((p) => p.request.id === props.focus);
    if (at >= 0) {
      focused = true;
      setMissing(false);
      setIndex(at);
      queueMicrotask(() => document.querySelector(`[data-approval="${CSS.escape(props.focus!)}"]`)?.scrollIntoView({ block: "nearest" }));
    } else if (hubList.hubs().every((h) => h.hub.state.status.kind === "open")) {
      setMissing(true);
    }
  });
  const current = () => pending()[Math.min(index(), Math.max(0, pending().length - 1))];

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const item = current();
    const req = item?.request;
    const actions = item?.hub.actions;
    switch (e.key) {
      case "Escape":
        props.onClose();
        break;
      case "j":
      case "ArrowDown":
        setIndex((i) => Math.min(i + 1, pending().length - 1));
        break;
      case "k":
      case "ArrowUp":
        setIndex((i) => Math.max(i - 1, 0));
        break;
      case "a":
        if (req?.kind === "permission") void actions?.decide(req.id, { type: "allow" });
        break;
      case "d":
        if (req) void actions?.decide(req.id, { type: "deny", message: "The user denied this action." });
        break;
      case "o":
        if (req) {
          void actions?.open(req.sessionId);
          props.onClose();
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Spoken "allow" / "permitir" and "deny" / "negar" act on the selected card, never on always-ask ones.
  useVoice().useApprovalCommands((command) => {
    const item = current();
    if (!item) return "nothing is waiting";
    const req = item.request;
    const name = item.hub.state.sessions[req.sessionId]?.name ?? "the session";
    if (req.kind !== "permission") return "questions are answered on screen";
    if (req.mustAsk) return `${name}'s request is on the always-ask list; decide it with a click`;
    if (command === "allow") void item.hub.actions.decide(req.id, { type: "allow" });
    else void item.hub.actions.decide(req.id, { type: "deny", message: "The user denied this action by voice." });
    return `${command === "allow" ? "allowed" : "denied"}: ${req.summary}`;
  });

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <section class="dialog approvals-panel" aria-label="Pending approvals">
        <header class="panel-head">
          <h2>Approvals</h2>
          <span class="muted small key-hints">j/k move · a allow · d deny · o open session · Esc close · or say “allow” / “deny”</span>
          <button onClick={() => props.onClose()}>Close</button>
        </header>
        <Show when={missing()}>
          <p class="muted">That approval was already decided.</p>
        </Show>
        <Show when={pending().length > 0} fallback={<p class="muted">Nothing is waiting for you.</p>}>
          <div class="approvals-list">
            <For each={pending()}>
              {(item, i) => (
                <div data-approval={item.request.id} onClick={() => setIndex(i())}>
                  <HubContext.Provider value={item.hub}>
                    <ApprovalCard
                      request={item.request}
                      sessionName={`${hubList.hubs().length > 1 ? `${item.hub.state.hub?.name ?? "hub"} · ` : ""}${item.hub.state.sessions[item.request.sessionId]?.name ?? "session"}`}
                      selected={i() === index()}
                    />
                  </HubContext.Provider>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}

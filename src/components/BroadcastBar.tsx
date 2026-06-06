// The headline trick: type once, send to many. The bar writes `text` + a newline to every
// targeted live pane in the *active* workspace at once (PLAN M4). Scope is the whole
// workspace by default, or a hand-picked subset via "Targets" select-mode. Dead panes are
// skipped (the registry only writes to live ones); switching workspaces re-scopes the bar.
//
// This sends discrete messages, not a synchronized keystroke mirror (that's deferred) — so
// the input never steals focus from a pane's PTY; it's its own field, Enter sends.

import { createSignal, Show } from "solid-js";
import {
  activeWorkspace,
  appState,
  broadcastTargets,
  clearBroadcastTargets,
  setBroadcastSelecting,
} from "../stores/workspace";
import { countLive, writeToPanes } from "../lib/paneRegistry";

export default function BroadcastBar() {
  const [text, setText] = createSignal("");
  const [flash, setFlash] = createSignal<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const ws = activeWorkspace;
  const targets = (): number[] => {
    const w = ws();
    return w ? broadcastTargets(w) : [];
  };
  /** Live panes among the current targets — the bar's real reach. */
  const reach = () => countLive(targets());
  const selecting = () => appState.broadcastSelecting;
  const subset = () => (ws()?.broadcast.length ?? 0) > 0;

  function send() {
    const ids = targets();
    if (ids.length === 0) return;
    const n = writeToPanes(ids, text() + "\r");
    setText("");
    showFlash(`sent to ${n} pane${n === 1 ? "" : "s"}`);
  }

  function showFlash(msg: string) {
    clearTimeout(flashTimer);
    setFlash(msg);
    flashTimer = setTimeout(() => setFlash(null), 1600);
  }

  function toggleSelect() {
    const on = !selecting();
    setBroadcastSelecting(on);
    if (!on) clearBroadcastTargets(); // leaving select-mode → back to "all panes"
  }

  return (
    <div class="bcast" classList={{ selecting: selecting() }}>
      <span class="bcast-label">⌁ Broadcast</span>
      <input
        class="bcast-input"
        placeholder="Type a prompt → all live panes in this workspace"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); send(); }
          else if (e.key === "Escape" && selecting()) toggleSelect();
        }}
      />
      <button
        class="bcast-scope"
        classList={{ on: selecting() }}
        title={subset() ? "Editing a pane subset" : "Pick a subset of panes (default: all)"}
        onClick={toggleSelect}
      >
        {selecting() ? "Done" : "Targets"}
      </button>
      <span class="bcast-reach" classList={{ subset: subset() }}>
        → {reach()} live{subset() ? ` / ${targets().length} picked` : ""}
      </span>
      <button class="bcast-send primary" disabled={reach() === 0} onClick={send}>Send</button>
      <Show when={flash()}>
        <span class="bcast-flash">{flash()}</span>
      </Show>
    </div>
  );
}

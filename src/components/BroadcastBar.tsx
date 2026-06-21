// The headline trick: type once, send to many. The bar writes `text` + a newline to every
// targeted live pane in the *active* workspace at once (PLAN M4). Scope is the whole
// workspace by default, or a hand-picked subset via "Targets" select-mode (click panes, or
// filter by a name pattern). Dead panes are skipped; switching workspaces re-scopes the bar.
//
// Power-ups: ↑/↓ recalls recently-sent messages; a snippet menu saves/recalls canned prompts;
// an optional per-pane stagger spaces out sends so a fleet doesn't hit an API in one burst.
//
// This sends discrete messages, not a synchronized keystroke mirror (that's deferred) — so
// the input never steals focus from a pane's PTY; it's its own field, Enter sends.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  activeWorkspace,
  appState,
  broadcastTargets,
  clearBroadcastTargets,
  flaggedTargets,
  selectAllBroadcastTargets,
  setBroadcastByPattern,
  setBroadcastSelecting,
  setBroadcastTargets,
} from "../stores/workspace";
import { detectAgent } from "../lib/agents";
import type { PaneId } from "../ipc/protocol";
import { clearAttention } from "../stores/activity";
import { countLive, writeToPanes } from "../lib/paneRegistry";
import {
  pushBroadcastHistory,
  settings,
} from "../stores/settings";

export default function BroadcastBar() {
  // Recall history is the persisted send log (oldest first), shared across re-scopes + sessions.
  const history = () => settings.broadcastHistory;
  const [text, setText] = createSignal("");
  // Arm/disarm the bar (the on/off pill). Disarmed = a guard against accidental fleet-wide sends:
  // the field + Send go inert until you flip it back on. Defaults armed.
  const [armed, setArmed] = createSignal(true);
  const [flash, setFlash] = createSignal<string | null>(null);
  const [pattern, setPattern] = createSignal("");
  // The Targets scope dropdown (All live / per-agent group / current pane).
  const [scopeOpen, setScopeOpen] = createSignal(false);
  // Cursor into `history` while recalling with ↑/↓; -1 = not recalling (editing fresh text).
  let histIdx = -1;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const ws = activeWorkspace;
  const targets = (): number[] => {
    const w = ws();
    return w ? broadcastTargets(w) : [];
  };
  /** Live panes among the current targets — the bar's real reach. */
  const reach = () => countLive(targets());
  /** Panes currently flagging for input (`th attention`) — the needs-input triage target set. */
  const flagged = (): number[] => {
    const w = ws();
    return w ? flaggedTargets(w) : [];
  };
  const selecting = () => appState.broadcastSelecting;
  /** Total panes in the active workspace, and whether every one is explicitly picked. */
  const paneTotal = () => Object.keys(ws()?.panes ?? {}).length;
  const allPicked = () => paneTotal() > 0 && (ws()?.broadcast.length ?? 0) >= paneTotal();
  const focused = (): PaneId | null => ws()?.focused ?? null;

  /** Per-agent groups present in the active workspace (e.g. "claude" ×4), for the scope dropdown. */
  const groups = (): { id: string; label: string; ids: PaneId[] }[] => {
    const w = ws();
    if (!w) return [];
    const m = new Map<string, { id: string; label: string; ids: PaneId[] }>();
    for (const key of Object.keys(w.panes)) {
      const id = Number(key) as PaneId;
      const a = detectAgent(w.panes[id]?.command);
      if (!a) continue;
      if (!m.has(a.id)) m.set(a.id, { id: a.id, label: a.label, ids: [] });
      m.get(a.id)!.ids.push(id);
    }
    return [...m.values()];
  };

  /** Which dropdown scope is currently active, for the chip label + the selected-row highlight. */
  const sameSet = (a: PaneId[], b: PaneId[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const activeScope = (): { kind: "all" | "current" | "group" | "custom"; label: string } => {
    const w = ws();
    if (!w) return { kind: "all", label: "All" };
    const sel = w.broadcast;
    if (sel.length === 0) return { kind: "all", label: "All" };
    const f = focused();
    if (f !== null && sel.length === 1 && sel[0] === f) return { kind: "current", label: "Current" };
    const g = groups().find((gr) => sameSet(gr.ids, sel));
    if (g) return { kind: "group", label: g.label };
    return { kind: "custom", label: "Subset" };
  };

  // Close the scope dropdown on any outside click (its own menu stops propagation).
  onMount(() => {
    const close = () => setScopeOpen(false);
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });

  /** Apply a quick scope from the dropdown, then close it. */
  function pickScope(ids: PaneId[] | null) {
    setBroadcastSelecting(false);
    if (ids === null) clearBroadcastTargets();
    else setBroadcastTargets(ids);
    setScopeOpen(false);
  }

  /** Write the current text to `ids`, honouring the per-pane stagger. Returns how many panes it
   *  reached and whether it staggered (for the flash). Shared by send + flagged-reply. */
  function deliver(ids: number[]): { n: number; staggered: boolean } {
    const msg = text() + (settings.broadcastNewline ? "\r" : "");
    const stagger = settings.broadcastStaggerMs;
    if (stagger > 0) {
      // Fire one pane at a time, spaced by `stagger` ms (avoids a fleet stampeding an API).
      const live = ids.filter((id) => countLive([id]) > 0);
      live.forEach((id, k) => setTimeout(() => writeToPanes([id], msg), k * stagger));
      return { n: live.length, staggered: true };
    }
    return { n: writeToPanes(ids, msg), staggered: false };
  }

  function send() {
    const ids = targets();
    if (ids.length === 0) return;
    const { n, staggered } = deliver(ids);
    pushBroadcastHistory(text());
    setText("");
    histIdx = -1;
    showFlash(staggered ? `staggered to ${n} pane${n === 1 ? "" : "s"}` : `sent to ${n} pane${n === 1 ? "" : "s"}`);
  }

  /** Needs-input triage (IDEAS #1): answer once into exactly the panes flagging for input, then
   *  drop their flags — so the next batch of pauses is what's left lit. Ignores the picked subset. */
  function sendToFlagged() {
    const ids = flagged();
    if (ids.length === 0) return;
    const { n } = deliver(ids);
    ids.forEach((id) => clearAttention(id));
    pushBroadcastHistory(text());
    setText("");
    histIdx = -1;
    showFlash(`replied to ${n} flagged pane${n === 1 ? "" : "s"}`);
  }

  /** ↑/↓ through history: walk back from the newest, forward back to a fresh empty line. */
  function recall(dir: -1 | 1) {
    const h = history();
    if (h.length === 0) return;
    if (histIdx === -1) histIdx = h.length;
    histIdx = Math.max(0, Math.min(h.length, histIdx + dir));
    setText(histIdx === h.length ? "" : h[histIdx]);
  }

  function showFlash(msg: string) {
    clearTimeout(flashTimer);
    setFlash(msg);
    flashTimer = setTimeout(() => setFlash(null), 1600);
  }

  function toggleSelect() {
    const on = !selecting();
    setBroadcastSelecting(on);
    if (!on) { clearBroadcastTargets(); setPattern(""); } // leaving select-mode → back to "all panes"
  }

  function applyPattern(p: string) {
    setPattern(p);
    setBroadcastByPattern(p);
  }

  /** One-click select-all / deselect-all while picking targets in the active workspace. */
  function toggleAll() {
    if (allPicked()) clearBroadcastTargets();
    else selectAllBroadcastTargets();
    setPattern("");
  }

  return (
    <div class="bcast" classList={{ selecting: selecting(), disarmed: !armed() }}>
      <div class="bcast-lead">
        <button
          class="bcast-power"
          classList={{ on: armed() }}
          title={armed() ? "Broadcast armed — click to pause" : "Broadcast paused — click to arm"}
          onClick={() => setArmed((v) => !v)}
        >
          <span class="bcast-power-knob" />
        </button>
        <span class="bcast-label">Broadcast</span>
      </div>
      <span class="bcast-divider" />

      <input
        class="bcast-input"
        placeholder={armed() ? "Type a prompt → all live panes in this workspace" : "Broadcast paused"}
        disabled={!armed()}
        value={text()}
        onInput={(e) => { setText(e.currentTarget.value); histIdx = -1; }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); send(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); recall(-1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); recall(1); }
          else if (e.key === "Escape" && selecting()) toggleSelect();
        }}
      />

      <Show when={selecting()}>
        <button
          class="bcast-all"
          title={allPicked() ? "Deselect all panes" : "Select all panes in this workspace"}
          onClick={toggleAll}
        >
          {allPicked() ? "None" : "All"}
        </button>
        <input
          class="bcast-pattern"
          placeholder="name e.g. Cl*"
          value={pattern()}
          title="Select target panes by name (glob or substring)"
          onInput={(e) => applyPattern(e.currentTarget.value)}
        />
      </Show>

      <div class="bcast-scope-wrap">
        <button
          class="bcast-scope"
          classList={{ on: selecting() || scopeOpen() }}
          title="Choose who receives the broadcast"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setScopeOpen((v) => !v)}
        >
          <span class="bcast-scope-ic">⌖</span>
          <span>{selecting() ? "Picking" : `${activeScope().label} · ${reach()} live`}</span>
          <span class="bcast-caret">▾</span>
        </button>
        <Show when={scopeOpen()}>
          <div class="bcast-scope-menu" onPointerDown={(e) => e.stopPropagation()}>
            <div class="bcast-scope-head">Broadcast to</div>
            <button
              class="bcast-scope-row"
              classList={{ on: activeScope().kind === "all" }}
              onClick={() => pickScope(null)}
            >
              <span class="bcast-scope-ic accent">⌖</span>
              <span class="bcast-scope-name">All live panes</span>
              <span class="bcast-scope-count">{countLive(Object.keys(ws()?.panes ?? {}).map(Number))} live</span>
            </button>
            <For each={groups()}>
              {(g) => (
                <button
                  class="bcast-scope-row"
                  classList={{ on: activeScope().kind === "group" && activeScope().label === g.label }}
                  onClick={() => pickScope(g.ids)}
                >
                  <span class="bcast-scope-ic">◫</span>
                  <span class="bcast-scope-name">Group: {g.label}</span>
                  <span class="bcast-scope-count">{g.ids.length}</span>
                </button>
              )}
            </For>
            <Show when={focused() !== null}>
              <button
                class="bcast-scope-row"
                classList={{ on: activeScope().kind === "current" }}
                onClick={() => pickScope([focused()!])}
              >
                <span class="bcast-scope-ic">▣</span>
                <span class="bcast-scope-name">Current pane</span>
                <span class="bcast-scope-count">1</span>
              </button>
            </Show>
            <div class="bcast-scope-sep" />
            <button
              class="bcast-scope-row"
              classList={{ on: selecting() }}
              onClick={() => { setScopeOpen(false); if (!selecting()) toggleSelect(); }}
            >
              <span class="bcast-scope-ic">⊟</span>
              <span class="bcast-scope-name">Pick panes manually…</span>
            </button>
          </div>
        </Show>
      </div>
      <Show when={flagged().length > 0}>
        <button
          class="bcast-flagged"
          disabled={!text().trim() || !armed()}
          title="Send to the panes flagging for input, then clear their flags"
          onClick={sendToFlagged}
        >
          ⚑ Reply to {flagged().length} flagged
        </button>
      </Show>
      <button class="bcast-send primary" disabled={reach() === 0 || !armed()} onClick={send}>Send</button>
      <Show when={flash()}>
        <span class="bcast-flash">{flash()}</span>
      </Show>
    </div>
  );
}

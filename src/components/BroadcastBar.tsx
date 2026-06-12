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

import { createSignal, For, Show } from "solid-js";
import {
  activeWorkspace,
  appState,
  broadcastTargets,
  clearBroadcastTargets,
  flaggedTargets,
  selectAllBroadcastTargets,
  setBroadcastByPattern,
  setBroadcastSelecting,
} from "../stores/workspace";
import { clearAttention } from "../stores/activity";
import { countLive, writeToPanes } from "../lib/paneRegistry";
import {
  addBroadcastGroup,
  addBroadcastSnippet,
  pushBroadcastHistory,
  removeBroadcastGroup,
  removeBroadcastSnippet,
  settings,
} from "../stores/settings";

export default function BroadcastBar() {
  // Recall history is the persisted send log (oldest first), shared across re-scopes + sessions.
  const history = () => settings.broadcastHistory;
  const [text, setText] = createSignal("");
  const [flash, setFlash] = createSignal<string | null>(null);
  const [pattern, setPattern] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [groupsOpen, setGroupsOpen] = createSignal(false);
  const [groupName, setGroupName] = createSignal("");
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
  const subset = () => (ws()?.broadcast.length ?? 0) > 0;
  /** Total panes in the active workspace, and whether every one is explicitly picked. */
  const paneTotal = () => Object.keys(ws()?.panes ?? {}).length;
  const allPicked = () => paneTotal() > 0 && (ws()?.broadcast.length ?? 0) >= paneTotal();

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

  function useSnippet(s: string) {
    setText(s);
    setMenuOpen(false);
    histIdx = -1;
  }

  /** Flip the broadcast scope to a saved group: enter select-mode and resolve its name pattern. */
  function useGroup(p: string) {
    setBroadcastSelecting(true);
    applyPattern(p);
    setGroupsOpen(false);
  }

  /** Save the current Targets pattern under a name for one-click recall later. */
  function saveGroup() {
    addBroadcastGroup(groupName(), pattern());
    setGroupName("");
  }

  return (
    <div class="bcast" classList={{ selecting: selecting() }}>
      <span class="bcast-label">⌁ Broadcast</span>

      <div class="bcast-snip">
        <button
          class="bcast-snip-btn"
          title="Saved snippets"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ❑ ▾
        </button>
        <Show when={menuOpen()}>
          <div class="bcast-snip-menu" onPointerDown={(e) => e.stopPropagation()}>
            <button
              class="bcast-snip-save"
              disabled={!text().trim()}
              onClick={() => { addBroadcastSnippet(text()); setMenuOpen(false); }}
            >
              ＋ Save current as snippet
            </button>
            <For each={settings.broadcastSnippets} fallback={<div class="bcast-snip-empty">No snippets yet</div>}>
              {(s) => (
                <div class="bcast-snip-item">
                  <span class="bcast-snip-text" title={s} onClick={() => useSnippet(s)}>{s}</span>
                  <button class="bcast-snip-del" title="Delete snippet" onClick={() => removeBroadcastSnippet(s)}>✕</button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="bcast-snip">
        <button
          class="bcast-snip-btn"
          title="Saved target groups"
          onClick={() => setGroupsOpen((v) => !v)}
        >
          ⚐ ▾
        </button>
        <Show when={groupsOpen()}>
          <div class="bcast-snip-menu" onPointerDown={(e) => e.stopPropagation()}>
            <div class="bcast-group-save">
              <input
                class="bcast-group-name"
                placeholder="group name"
                value={groupName()}
                onInput={(e) => setGroupName(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveGroup(); }}
              />
              <button
                class="bcast-snip-save"
                disabled={!groupName().trim() || !pattern().trim()}
                title={pattern().trim() ? "" : "Type a Targets name pattern first"}
                onClick={saveGroup}
              >
                ＋ Save “{pattern().trim() || "…"}”
              </button>
            </div>
            <For each={settings.broadcastGroups} fallback={<div class="bcast-snip-empty">No groups yet — pick a Targets pattern, then save it</div>}>
              {(g) => (
                <div class="bcast-snip-item">
                  <span class="bcast-snip-text" title={`${g.name}: ${g.pattern}`} onClick={() => useGroup(g.pattern)}>
                    {g.name} <em class="bcast-group-pat">{g.pattern}</em>
                  </span>
                  <button class="bcast-snip-del" title="Delete group" onClick={() => removeBroadcastGroup(g.name)}>✕</button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <input
        class="bcast-input"
        placeholder="Type a prompt → all live panes in this workspace"
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
      <Show when={flagged().length > 0}>
        <button
          class="bcast-flagged"
          disabled={!text().trim()}
          title="Send to the panes flagging for input, then clear their flags"
          onClick={sendToFlagged}
        >
          ⚑ Reply to {flagged().length} flagged
        </button>
      </Show>
      <button class="bcast-send primary" disabled={reach() === 0} onClick={send}>Send</button>
      <Show when={flash()}>
        <span class="bcast-flash">{flash()}</span>
      </Show>
    </div>
  );
}

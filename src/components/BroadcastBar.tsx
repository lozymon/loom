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
  setBroadcastByPattern,
  setBroadcastSelecting,
} from "../stores/workspace";
import { countLive, writeToPanes } from "../lib/paneRegistry";
import { addBroadcastSnippet, pushBroadcastHistory, removeBroadcastSnippet, settings } from "../stores/settings";

export default function BroadcastBar() {
  // Recall history is the persisted send log (oldest first), shared across re-scopes + sessions.
  const history = () => settings.broadcastHistory;
  const [text, setText] = createSignal("");
  const [flash, setFlash] = createSignal<string | null>(null);
  const [pattern, setPattern] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
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
  const selecting = () => appState.broadcastSelecting;
  const subset = () => (ws()?.broadcast.length ?? 0) > 0;

  function send() {
    const ids = targets();
    if (ids.length === 0) return;
    const msg = text() + (settings.broadcastNewline ? "\r" : "");
    const stagger = settings.broadcastStaggerMs;
    let n: number;
    if (stagger > 0) {
      // Fire one pane at a time, spaced by `stagger` ms (avoids a fleet stampeding an API).
      const live = ids.filter((id) => countLive([id]) > 0);
      live.forEach((id, k) => setTimeout(() => writeToPanes([id], msg), k * stagger));
      n = live.length;
    } else {
      n = writeToPanes(ids, msg);
    }
    pushBroadcastHistory(text());
    setText("");
    histIdx = -1;
    showFlash(stagger > 0 ? `staggered to ${n} pane${n === 1 ? "" : "s"}` : `sent to ${n} pane${n === 1 ? "" : "s"}`);
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

  function useSnippet(s: string) {
    setText(s);
    setMenuOpen(false);
    histIdx = -1;
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
      <button class="bcast-send primary" disabled={reach() === 0} onClick={send}>Send</button>
      <Show when={flash()}>
        <span class="bcast-flash">{flash()}</span>
      </Show>
    </div>
  );
}

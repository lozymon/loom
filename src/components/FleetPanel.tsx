// Fleet panel — a read-only window onto the active workspace's *coordination state* (§2): the
// shared blackboard (loom note / board_*) and the file claims (loom claim / claim_*). It makes the
// otherwise-invisible cross-pane state a fleet builds up visible in one place — who owns which file,
// what plan notes are posted — so you can see at a glance what your agents have agreed on.
//
// Docks to the right like the Source Control / Docs panels and reuses their shell classes. Purely
// reactive off the two stores (no polling, no bus calls): posting a note or taking a claim from any
// pane updates this live. Scoped to the active workspace by id; switching workspaces re-scopes it.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace } from "../stores/workspace";
import { board, noteList } from "../stores/blackboard";
import { claims, listClaims, releaseFile } from "../stores/claims";
import { settings, setSetting } from "../stores/settings";
import { claudeUsage, sessionCost, sessionTokens, fmtTokens, fmtUsd, type SessionUsage } from "../lib/claudeUsage";

export default function FleetPanel(props: { onClose: () => void }) {
  const wsId = () => activeWorkspace()?.id ?? "";

  // Reactive views: reading board[wsId] / claims[wsId] inside the memo subscribes to that
  // workspace's slice, so a note/claim from any pane re-renders the list. `board`/`claims` are
  // referenced so the tracking is explicit even though noteList/listClaims read them internally.
  const notes = createMemo(() => {
    void board[wsId()];
    return noteList(wsId());
  });
  const held = createMemo(() => {
    void claims[wsId()];
    return listClaims(wsId());
  });

  // ---- Usage HUD (AGENTIC §1c): per-pane Claude token spend + estimated cost, read on demand
  // from Claude's on-disk transcripts (lib/claudeUsage.ts). Not reactive/polled — it's file I/O, so
  // it loads when the panel opens / the workspace changes, and on the Refresh button.
  const [usage, setUsage] = createSignal<SessionUsage[]>([]);
  const [loadingUsage, setLoadingUsage] = createSignal(false);

  /** The active workspace's Claude panes that carry a captured session id (managed/adopted). */
  const claudePanes = () => {
    const ws = activeWorkspace();
    if (!ws) return [] as { title: string; sessionId: string }[];
    return Object.values(ws.panes)
      .filter((s) => !!s.sessionId)
      .map((s) => ({ title: s.title, sessionId: s.sessionId! }));
  };

  async function refreshUsage() {
    const ids = claudePanes().map((p) => p.sessionId);
    if (ids.length === 0) { setUsage([]); return; }
    setLoadingUsage(true);
    try { setUsage(await claudeUsage(ids)); } finally { setLoadingUsage(false); }
  }
  // Load on open and whenever the active workspace (and thus its panes) changes.
  createEffect(() => { void wsId(); void refreshUsage(); });

  const usageById = createMemo(() => new Map(usage().map((u) => [u.id, u])));
  const usageRows = createMemo(() =>
    claudePanes().map((p) => {
      const u = usageById().get(p.sessionId);
      return {
        title: p.title,
        model: u?.models[0]?.model ?? "",
        tokens: u ? sessionTokens(u) : 0,
        cost: u ? sessionCost(u) : 0,
      };
    }),
  );
  const totalCost = createMemo(() => usageRows().reduce((s, r) => s + r.cost, 0));
  const totalTokens = createMemo(() => usageRows().reduce((s, r) => s + r.tokens, 0));

  // Drag the left edge to resize (mirrors the Docs/Git panels); clamp + persist.
  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.fleetWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(280, Math.min(720, startW + (startX - ev.clientX)));
      setSetting("fleetWidth", w);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <aside
      class="side-panel git-panel fleet-panel git-scm"
      style={{ "flex-basis": `${settings.fleetWidth}px`, width: `${settings.fleetWidth}px` }}
    >
      <div class="git-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
      <header class="git-head">
        <span class="git-title" title={activeWorkspace()?.name}>Fleet · {activeWorkspace()?.name ?? ""}</span>
        <span class="git-head-actions">
          <button class="git-icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
        </span>
      </header>

      <div class="fleet-body">
        <section class="fleet-section">
          <div class="fleet-section-head">
            <span class="fleet-section-title">Blackboard</span>
            <span class="fleet-count">{notes().length}</span>
          </div>
          <Show
            when={notes().length > 0}
            fallback={<div class="fleet-empty">No notes. Agents post with <code>loom note set</code>.</div>}
          >
            <ul class="fleet-list">
              <For each={notes()}>
                {(n) => (
                  <li class="fleet-row">
                    <div class="fleet-row-main">
                      <span class="fleet-key">{n.key}</span>
                      <span class="fleet-value">{n.value}</span>
                    </div>
                    <span class="fleet-by" title="Last writer">{n.by}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="fleet-section">
          <div class="fleet-section-head">
            <span class="fleet-section-title">File claims</span>
            <span class="fleet-count">{held().length}</span>
          </div>
          <Show
            when={held().length > 0}
            fallback={<div class="fleet-empty">No files claimed. Agents lock with <code>loom claim</code>.</div>}
          >
            <ul class="fleet-list">
              <For each={held()}>
                {(c) => (
                  <li class="fleet-row" classList={{ "fleet-gated": c.held }}>
                    <span class="fleet-path" title={c.path}>{c.path}</span>
                    <Show when={c.held} fallback={<span class="fleet-by" title="Locked by">{c.by}</span>}>
                      <span class="fleet-gate-badge" title="Gated for approval — an agent's claim on this path is blocked until released">⛔ gated</span>
                      <button class="fleet-release" title="Release the gate — let the agent proceed" onClick={() => releaseFile(wsId(), c.path, c.by, true)}>release</button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="fleet-section">
          <div class="fleet-section-head">
            <span class="fleet-section-title">Usage <span class="fleet-est" title="Estimated from current Claude pricing">est.</span></span>
            <span class="git-head-actions">
              <Show when={usageRows().length > 0}>
                <span class="fleet-usage-total" title="Workspace total — tokens · estimated cost">{fmtTokens(totalTokens())} · {fmtUsd(totalCost())}</span>
              </Show>
              <button class="git-icon-btn" title="Refresh usage" disabled={loadingUsage()} onClick={() => void refreshUsage()}>⟳</button>
            </span>
          </div>
          <Show
            when={usageRows().length > 0}
            fallback={<div class="fleet-empty">No Claude panes with a session yet. Usage appears once an agent pane has a conversation.</div>}
          >
            <ul class="fleet-list">
              <For each={usageRows()}>
                {(r) => (
                  <li class="fleet-row fleet-usage-row">
                    <div class="fleet-row-main">
                      <span class="fleet-key" title={r.model || undefined}>{r.title}</span>
                      <span class="fleet-value">{fmtTokens(r.tokens)} tokens</span>
                    </div>
                    <span class="fleet-usage-cost" title="Estimated cost">{fmtUsd(r.cost)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </aside>
  );
}

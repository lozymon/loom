// Fleet panel — a read-only window onto the active workspace's *coordination state* (§2): the
// shared blackboard (loom note / board_*) and the file claims (loom claim / claim_*). It makes the
// otherwise-invisible cross-pane state a fleet builds up visible in one place — who owns which file,
// what plan notes are posted — so you can see at a glance what your agents have agreed on.
//
// Docks to the right like the Source Control / Docs panels and reuses their shell classes. Purely
// reactive off the two stores (no polling, no bus calls): posting a note or taking a claim from any
// pane updates this live. Scoped to the active workspace by id; switching workspaces re-scopes it.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace, listGatedPanes, focusPane, activeRolePanes, CANONICAL_ROLES } from "../stores/workspace";
import { board, noteList, ensureNotesLoaded } from "../stores/blackboard";
import { claims, listClaims, releaseFile } from "../stores/claims";
import { holds, releaseGate } from "../stores/inputHolds";
import { openAsks, dismissAsk } from "../stores/openAsks";
import { settings, setSetting } from "../stores/settings";
import { claudeUsage, sessionCost, sessionTokens, fmtTokens, fmtUsd, type SessionUsage } from "../lib/claudeUsage";

/** Coarse "how long ago" label for the open-asks list — seconds under a minute, then minutes/hours. */
function ago(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export default function FleetPanel(props: { onClose: () => void }) {
  const wsId = () => activeWorkspace()?.id ?? "";
  // The blackboard is now project-scoped (keyed by folder, persisted to .loom/notes.json), so notes
  // read off the workspace's cwd; claims stay per-workspace (ephemeral).
  const dir = () => activeWorkspace()?.cwd ?? "";

  // Reactive views: reading board[dir] / claims[wsId] inside the memo subscribes to that slice, so a
  // note/claim from any pane re-renders the list. `board`/`claims` are referenced so the tracking is
  // explicit even though noteList/listClaims read them internally.
  const notes = createMemo(() => {
    void board[dir()];
    return noteList(dir());
  });
  const held = createMemo(() => {
    void claims[wsId()];
    return listClaims(wsId());
  });
  // Gated panes (§4a) whose inbound bus input is held, scoped to the active workspace. Touch the
  // holds key-set so gating/releasing from any pane re-renders.
  const gated = createMemo(() => {
    void Object.keys(holds);
    const name = activeWorkspace()?.name;
    return listGatedPanes().filter((g) => g.workspace === name);
  });
  // Load the project's persisted notes when the folder changes (idempotent; "" = in-memory only).
  createEffect(() => { void ensureNotesLoaded(dir()); });

  // ---- Role roster + filter (ORCHESTRATION §2). Groups the active workspace's panes by their
  // persisted `role` field (reactive off activeRolePanes), leads with the canonical vocabulary as a
  // stable filter bar, and lets the operator narrow the pane list to one role. `roleFilter`: null =
  // All; "" = unassigned (role-less); otherwise a lower-cased role key.
  const [roleFilter, setRoleFilter] = createSignal<string | null>(null);
  const rolePanes = createMemo(() => activeRolePanes());
  const roster = createMemo(() => {
    const counts = new Map<string, { display: string; count: number }>();
    let unassigned = 0;
    for (const p of rolePanes()) {
      const raw = p.role?.trim();
      if (!raw) { unassigned++; continue; }
      const key = raw.toLowerCase();
      const e = counts.get(key);
      if (e) e.count++;
      else counts.set(key, { display: raw, count: 1 });
    }
    const groups: { key: string; label: string; count: number }[] =
      CANONICAL_ROLES.map((c) => ({ key: c, label: c, count: counts.get(c)?.count ?? 0 }));
    for (const [key, { display, count }] of counts) {
      if (!(CANONICAL_ROLES as readonly string[]).includes(key)) groups.push({ key, label: display, count });
    }
    return { groups, unassigned };
  });
  // Panes shown under the roster, narrowed to the active filter.
  const filteredPanes = createMemo(() => {
    const f = roleFilter();
    const panes = rolePanes();
    if (f === null) return panes;
    if (f === "") return panes.filter((p) => !p.role?.trim());
    return panes.filter((p) => p.role?.trim().toLowerCase() === f);
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

  // A coarse clock so the Open-asks "waited 3m" ages advance while the panel is open, without a
  // per-row timer. 15s is fine for minute-granularity display.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    onCleanup(() => clearInterval(t));
  });

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
            <span class="fleet-section-title">Roles</span>
            <span class="fleet-count">{rolePanes().length}</span>
          </div>
          <div class="fleet-roster">
            <button
              class="fleet-role-chip"
              classList={{ active: roleFilter() === null }}
              onClick={() => setRoleFilter(null)}
            >
              All <span class="fleet-role-n">{rolePanes().length}</span>
            </button>
            <For each={roster().groups}>
              {(g) => (
                <button
                  class="fleet-role-chip"
                  classList={{ active: roleFilter() === g.key, "fleet-role-empty": g.count === 0 }}
                  disabled={g.count === 0}
                  title={g.count === 0 ? `No ${g.label} panes` : `Show ${g.count} ${g.label} pane${g.count === 1 ? "" : "s"}`}
                  onClick={() => setRoleFilter(roleFilter() === g.key ? null : g.key)}
                >
                  {g.label} <span class="fleet-role-n">{g.count}</span>
                </button>
              )}
            </For>
            <Show when={roster().unassigned > 0}>
              <button
                class="fleet-role-chip"
                classList={{ active: roleFilter() === "" }}
                title="Panes with no role assigned"
                onClick={() => setRoleFilter(roleFilter() === "" ? null : "")}
              >
                unassigned <span class="fleet-role-n">{roster().unassigned}</span>
              </button>
            </Show>
          </div>
          <Show
            when={filteredPanes().length > 0}
            fallback={<div class="fleet-empty">No panes here. Tag one with <code>loom role &lt;pane&gt; &lt;role&gt;</code>.</div>}
          >
            <ul class="fleet-list">
              <For each={filteredPanes()}>
                {(p) => (
                  <li class="fleet-row fleet-role-row" classList={{ "fleet-focused": p.focused }}>
                    <button class="fleet-role-pane" title="Focus this pane" onClick={() => focusPane(p.paneId)}>
                      <span class="fleet-key">{p.name}</span>
                    </button>
                    <Show when={p.role} fallback={<span class="fleet-role-none" title="No role assigned">—</span>}>
                      {(r) => <span class="fleet-by" title={`Role: ${r()} — address it on the bus as role:${r()}`}>{r()}</span>}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

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
            <span class="fleet-section-title">Input gates</span>
            <span class="fleet-count">{gated().length}</span>
          </div>
          <Show
            when={gated().length > 0}
            fallback={<div class="fleet-empty">No panes gated. Hold a pane's bus input with <code>loom gate &lt;pane&gt;</code>.</div>}
          >
            <ul class="fleet-list">
              <For each={gated()}>
                {(g) => (
                  <li class="fleet-row fleet-gated">
                    <div class="fleet-row-main">
                      <span class="fleet-path" title={`Bus input held for ${g.name}`}>🔒 {g.name}</span>
                      <Show when={g.reason}>
                        <span class="fleet-value">{g.reason}</span>
                      </Show>
                    </div>
                    <button class="fleet-release" title="Release the gate — let bus input reach this pane" onClick={() => releaseGate(g.paneId)}>release</button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="fleet-section">
          <div class="fleet-section-head">
            <span class="fleet-section-title">Open asks</span>
            <span class="fleet-count">{openAsks.length}</span>
          </div>
          <Show
            when={openAsks.length > 0}
            fallback={<div class="fleet-empty">No open asks. Agents ask another pane with <code>loom ask &lt;pane&gt; "…"</code>.</div>}
          >
            <ul class="fleet-list">
              <For each={openAsks}>
                {(a) => (
                  <li class="fleet-row fleet-ask-row">
                    <div class="fleet-row-main">
                      <div class="fleet-ask-head">
                        <span class="fleet-by" title="Asked by">{a.from}</span>
                        <span class="fleet-ask-arrow">→</span>
                        <span class="fleet-by" title="Waiting on">{a.target}</span>
                        <span class="fleet-ask-age" title="Waiting for a reply">{ago(a.at, now())}</span>
                      </div>
                      <span class="fleet-value">{a.question}</span>
                    </div>
                    <button class="fleet-release" title="Dismiss — the waiting loom ask resolves unknown" onClick={() => dismissAsk(a.id)}>dismiss</button>
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

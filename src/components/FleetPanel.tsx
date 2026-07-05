// Fleet panel — a read-only window onto the active workspace's *coordination state* (§2): the
// shared blackboard (loom note / board_*) and the file claims (loom claim / claim_*). It makes the
// otherwise-invisible cross-pane state a fleet builds up visible in one place — who owns which file,
// what plan notes are posted — so you can see at a glance what your agents have agreed on.
//
// Docks to the right like the Source Control / Docs panels and reuses their shell classes. Purely
// reactive off the two stores (no polling, no bus calls): posting a note or taking a claim from any
// pane updates this live. Scoped to the active workspace by id; switching workspaces re-scopes it.

import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace } from "../stores/workspace";
import { board, noteList } from "../stores/blackboard";
import { claims, listClaims } from "../stores/claims";
import { settings, setSetting } from "../stores/settings";

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
                  <li class="fleet-row">
                    <span class="fleet-path" title={c.path}>{c.path}</span>
                    <span class="fleet-by" title="Held by">{c.by}</span>
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

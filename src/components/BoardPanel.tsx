// Task board panel (ORCHESTRATION-IDEAS §1) — a docked Kanban of work cards that dispatch into
// panes. Mirrors the Fleet/Git/Docs panel shell. A card in To-do carries a launch spec + prompt;
// Dispatch spawns a pane from it and pins the card to that pane, whose live Session/Task state
// (ADR-0008) then drives the card's sub-state (and auto-moves it to Done when the task ends).
// Purely reactive off stores/board + stores/sessions + stores/activity (no polling, no Rust).

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeWorkspace, revealPane } from "../stores/workspace";
import { board, cards, addCard, removeCard, dispatchCard, setCardStatus, ensureBoardLoaded, type BoardCard } from "../stores/board";
import { paneActiveTask } from "../stores/sessions";
import { activity } from "../stores/activity";
import { settings, setSetting } from "../stores/settings";
import type { PaneId } from "../ipc/protocol";

type LiveState = "working" | "needs" | "idle" | "done" | "dead";

export default function BoardPanel(props: { onClose: () => void }) {
  // Cards are project-scoped: keyed by the workspace's working folder (its `.loom/board.json`).
  const dir = () => activeWorkspace()?.cwd ?? "";
  // Load the project's board from `.loom` when the folder changes (idempotent; "" = in-memory only).
  createEffect(() => { void ensureBoardLoaded(dir()); });

  // Reading board[dir] inside the memo subscribes to that project's cards.
  const wsCards = createMemo(() => { void board[dir()]; return cards(dir()); });
  const todo = createMemo(() => wsCards().filter((c) => c.status === "todo"));
  const active = createMemo(() => wsCards().filter((c) => c.status === "dispatched"));
  const done = createMemo(() => wsCards().filter((c) => c.status === "done" || c.status === "failed"));

  // Live sub-state of a dispatched card's pane: agent-pushed Task first (ADR-0008), then the
  // kernel/attention floor (activity). Never reads pane output.
  const liveState = (paneId?: PaneId): LiveState => {
    if (paneId == null) return "idle";
    const t = paneActiveTask(paneId);
    if (t?.state === "blocked") return "needs";
    if (t?.state === "failed") return "dead";
    if (t?.state === "done") return "done";
    const a = activity[paneId];
    if (a?.attention || a?.stuck) return "needs";
    if (a?.busy === true) return "working";
    return "idle";
  };

  // Auto-move: when a dispatched card's Task ends, drive the card to its lane (the "state flows back
  // to the card" idea). Best-effort — only agents that push ADR-0008 signals report a Task; others
  // stay dispatched until you mark them done.
  createEffect(() => {
    for (const c of wsCards()) {
      if (c.status !== "dispatched" || c.paneId == null) continue;
      const t = paneActiveTask(c.paneId);
      if (t?.state === "done") setCardStatus(dir(), c.id, "done");
      else if (t?.state === "failed") setCardStatus(dir(), c.id, "failed");
    }
  });

  // ---- Add-card form ----
  const [title, setTitle] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [command, setCommand] = createSignal("claude");
  function submit(e: Event) {
    e.preventDefault();
    if (!title().trim()) return;
    addCard(dir(), { title: title(), prompt: prompt(), command: command() });
    setTitle(""); setPrompt("");
  }

  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = settings.boardWidth;
    const move = (ev: PointerEvent) => setSetting("boardWidth", Math.max(300, Math.min(760, startW + (startX - ev.clientX))));
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const card = (c: BoardCard) => (
    <li class="board-card" onClick={() => c.paneId != null && revealPane(c.paneId)}>
      <div class="board-card-head">
        <Show when={c.status === "dispatched"}>
          <span class="pane-dot" data-state={liveState(c.paneId)} />
        </Show>
        <span class="board-card-title" title={c.title}>{c.title}</span>
        <span class="board-card-actions">
          <Show when={c.status === "todo"}>
            <button class="board-btn" title="Dispatch — spawn a pane and run this" onClick={(e) => { e.stopPropagation(); dispatchCard(dir(), c.id); }}>▷</button>
          </Show>
          <Show when={c.status === "dispatched"}>
            <button class="board-btn" title="Mark done" onClick={(e) => { e.stopPropagation(); setCardStatus(dir(), c.id, "done"); }}>✓</button>
          </Show>
          <button class="board-btn board-btn-del" title="Delete card" onClick={(e) => { e.stopPropagation(); removeCard(dir(), c.id); }}>✕</button>
        </span>
      </div>
      <Show when={c.prompt}>
        <div class="board-card-prompt" title={c.prompt}>{c.prompt}</div>
      </Show>
      <div class="board-card-meta">
        <span class="board-card-cmd">{c.command}</span>
        <Show when={c.status === "failed"}><span class="board-card-fail">failed</span></Show>
      </div>
    </li>
  );

  const column = (label: string, list: () => BoardCard[]) => (
    <section class="board-col">
      <div class="fleet-section-head">
        <span class="fleet-section-title">{label}</span>
        <span class="fleet-count">{list().length}</span>
      </div>
      <Show when={list().length > 0} fallback={<div class="fleet-empty board-empty">—</div>}>
        <ul class="board-list"><For each={list()}>{(c) => card(c)}</For></ul>
      </Show>
    </section>
  );

  return (
    <aside class="side-panel git-panel board-panel git-scm" style={{ "flex-basis": `${settings.boardWidth}px`, width: `${settings.boardWidth}px` }}>
      <div class="git-resizer" title="Drag to resize" onPointerDown={onResizeDown} />
      <header class="git-head">
        <span class="git-title" title={activeWorkspace()?.name}>Board · {activeWorkspace()?.name ?? ""}</span>
        <span class="git-head-actions">
          <button class="git-icon-btn" title="Close (Esc)" onClick={() => props.onClose()}>✕</button>
        </span>
      </header>

      <form class="board-add" onSubmit={submit}>
        <input class="board-input" placeholder="New task title…" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
        <textarea class="board-input board-prompt" rows={2} placeholder="Prompt to run (optional)…" value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} />
        <div class="board-add-row">
          <input class="board-input board-cmd-input" placeholder="Agent command" value={command()} onInput={(e) => setCommand(e.currentTarget.value)} />
          <button class="board-add-btn" type="submit" disabled={!title().trim()}>Add</button>
        </div>
      </form>

      <div class="board-body">
        {column("To do", todo)}
        {column("In progress", active)}
        {column("Done", done)}
      </div>
    </aside>
  );
}

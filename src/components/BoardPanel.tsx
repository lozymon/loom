// Task board panel (ORCHESTRATION-IDEAS §1) — a docked Kanban of work cards that dispatch into
// panes. Mirrors the Fleet/Git/Docs panel shell. A card in To-do carries a launch spec + prompt;
// Dispatch spawns a pane from it and pins the card to that pane, whose live Session/Task state
// (ADR-0008) then drives the card's sub-state (and auto-moves it to Done when the task ends).
// Purely reactive off stores/board + stores/sessions + stores/activity (no polling, no Rust).

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import MarkdownEditor from "./MarkdownEditor";
import { activeWorkspace, revealPane } from "../stores/workspace";
import { board, cards, addCard, updateCard, removeCard, dispatchCard, setCardStatus, reorderCard, ensureBoardLoaded, type BoardCard } from "../stores/board";
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

  // ---- Card form — a floating, movable, resizable, NON-modal dialog (no backdrop) so you can keep
  // working in the terminal behind it. `formMode` is null (closed), { editId: null } (new), or
  // { editId } (editing that card). ----
  const [formMode, setFormMode] = createSignal<{ editId: string | null } | null>(null);
  const [title, setTitle] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [command, setCommand] = createSignal("claude");
  const [floatPos, setFloatPos] = createSignal({ x: 120, y: 90 });
  let titleInput: HTMLInputElement | undefined;

  // Position the dialog on open: reuse the last remembered spot (clamped back on-screen in case the
  // window shrank), or center it the first time (saved x = -1).
  function placeFloat() {
    const w = settings.boardDialogWidth;
    if (settings.boardDialogX < 0) {
      setFloatPos({ x: Math.max(20, Math.round(window.innerWidth / 2 - w / 2)), y: 90 });
      return;
    }
    const x = Math.min(Math.max(0, settings.boardDialogX), Math.max(0, window.innerWidth - 80));
    const y = Math.min(Math.max(0, settings.boardDialogY), Math.max(0, window.innerHeight - 48));
    setFloatPos({ x, y });
  }
  function openNew() {
    setTitle(""); setPrompt(""); setCommand("claude");
    placeFloat();
    setFormMode({ editId: null });
    queueMicrotask(() => titleInput?.focus());
  }
  function openEdit(c: BoardCard) {
    setTitle(c.title); setPrompt(c.prompt); setCommand(c.command);
    placeFloat();
    setFormMode({ editId: c.id });
    queueMicrotask(() => titleInput?.select());
  }
  function closeForm() { setFormMode(null); }
  function submitForm(e: Event) {
    e.preventDefault();
    const m = formMode();
    if (!m || !title().trim()) return;
    if (m.editId === null) addCard(dir(), { title: title(), prompt: prompt(), command: command() });
    else updateCard(dir(), m.editId, { title: title(), prompt: prompt(), command: command() });
    closeForm();
  }

  // Restore the last resized dialog size on open, and persist new sizes as the user drags the grip
  // (native `resize: both` writes inline width/height; a ResizeObserver mirrors it into settings).
  let saveSizeTimer: ReturnType<typeof setTimeout> | undefined;
  function bindFloat(el: HTMLFormElement) {
    el.style.width = `${settings.boardDialogWidth}px`;
    el.style.height = `${settings.boardDialogHeight}px`;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (w === settings.boardDialogWidth && h === settings.boardDialogHeight) return;
      clearTimeout(saveSizeTimer);
      saveSizeTimer = setTimeout(() => { setSetting("boardDialogWidth", w); setSetting("boardDialogHeight", h); }, 250);
    });
    ro.observe(el);
    onCleanup(() => { ro.disconnect(); clearTimeout(saveSizeTimer); });
  }

  // Drag the dialog by its title bar (ignore clicks on the close button).
  function onFloatDrag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = floatPos();
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: PointerEvent) => setFloatPos({ x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) });
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = floatPos();
      setSetting("boardDialogX", Math.round(p.x));
      setSetting("boardDialogY", Math.round(p.y));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---- Pointer-based drag-to-reorder within a lane. (HTML5 drag-and-drop is unreliable in
  // WebKitGTK — drop events often never fire — so we track pointer moves ourselves, the same way the
  // dialog-drag and panel-resizer do.) ----
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{ id: string; place: "before" | "after" } | null>(null);
  let draggedThisPress = false; // set when a press turned into a real drag, to suppress the click

  function onCardPointerDown(e: PointerEvent, c: BoardCard) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // let card buttons handle their own clicks
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5 && Math.abs(ev.clientX - startX) < 5) return;
        dragging = true;
        setDragId(c.id);
      }
      // Which card is the pointer over? Resolve via the DOM (each <li> carries data-card-id).
      const li = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest(".board-card") as HTMLElement | null;
      const tid = li?.dataset.cardId;
      const target = tid ? wsCards().find((x) => x.id === tid) : undefined;
      if (!target || target.id === c.id || target.status !== c.status) { setDropTarget(null); return; }
      const r = li!.getBoundingClientRect();
      setDropTarget({ id: target.id, place: ev.clientY < r.top + r.height / 2 ? "before" : "after" });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = dragId(), t = dropTarget();
      if (dragging && d && t) reorderCard(dir(), d, t.id, t.place);
      draggedThisPress = dragging; // a real drag just happened → the trailing click must not open edit
      setDragId(null); setDropTarget(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onCardClick(c: BoardCard) {
    if (draggedThisPress) { draggedThisPress = false; return; } // that click was the end of a drag
    openEdit(c);
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

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (formMode()) closeForm(); else props.onClose(); // Esc closes the dialog first, then the panel
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const card = (c: BoardCard) => (
    <li
      class="board-card"
      data-card-id={c.id}
      classList={{
        "board-card-dragging": dragId() === c.id,
        "board-drop-before": dropTarget()?.id === c.id && dropTarget()?.place === "before",
        "board-drop-after": dropTarget()?.id === c.id && dropTarget()?.place === "after",
      }}
      title="Click to edit · drag to reorder"
      onPointerDown={(e) => onCardPointerDown(e, c)}
      onClick={() => onCardClick(c)}
    >
      <div class="board-card-head">
        <Show when={c.status === "dispatched"}>
          <button class="board-dot-btn" title="Reveal the pane" onClick={(e) => { e.stopPropagation(); c.paneId != null && revealPane(c.paneId); }}>
            <span class="pane-dot" data-state={liveState(c.paneId)} />
          </button>
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

      <button class="board-new" onClick={() => openNew()}>＋ New task</button>

      <div class="board-body">
        {column("To do", todo)}
        {column("In progress", active)}
        {column("Done", done)}
      </div>

      {/* Create / edit dialog — a floating, movable, resizable, NON-modal panel (no backdrop): drag
          its title bar to move, drag its bottom-right corner to resize, and keep working in the
          terminal behind it. */}
      <Show when={formMode()}>
        {(m) => (
          <form ref={bindFloat} class="board-float" style={{ left: `${floatPos().x}px`, top: `${floatPos().y}px` }} onSubmit={submitForm}>
            <div class="board-float-head" onPointerDown={onFloatDrag}>
              <span class="board-float-title">{m().editId === null ? "New task" : "Edit task"}</span>
              <button class="git-icon-btn" type="button" title="Close (Esc)" onClick={() => closeForm()}>✕</button>
            </div>
            <div class="board-float-body">
              <input ref={titleInput} class="board-input" placeholder="Task title…" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
              <MarkdownEditor class="board-float-prompt" value={prompt()} onInput={setPrompt} placeholder="Description / prompt (Markdown) — run on dispatch…" />
              <label class="board-modal-label">Agent command</label>
              <input class="board-input board-cmd-input" placeholder="claude" value={command()} onInput={(e) => setCommand(e.currentTarget.value)} />
              <div class="board-modal-actions">
                <button class="board-btn-ghost" type="button" onClick={() => closeForm()}>Cancel</button>
                <button class="board-add-btn" type="submit" disabled={!title().trim()}>{m().editId === null ? "Add" : "Save"}</button>
              </div>
            </div>
          </form>
        )}
      </Show>
    </aside>
  );
}

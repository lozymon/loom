import type { Card, CardInput, CardKind, CardStatus, PermissionLevel } from "@loom/protocol";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useHub } from "../hub/store.ts";
import { MODEL_CHOICES, stateLabel } from "../lib/format.ts";
import { projectName } from "../lib/projects.ts";
import { LevelSelect } from "./LevelSelect.tsx";

const LANES: Array<{ id: CardStatus; label: string }> = [
  { id: "todo", label: "To do" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

const KIND_LABEL: Record<CardKind, string> = { chat: "Claude chat", "claude-terminal": "Claude terminal", terminal: "Terminal" };

/** A project's task board (M4). Cards dispatch into sessions and follow them. */
export function Board(props: { root: string }) {
  const { state, actions } = useHub();
  const board = () => state.boards[props.root];
  const [editing, setEditing] = createSignal<Card | "new" | undefined>();
  const [cap, setCap] = createSignal(3);
  const byLane = createMemo(() => {
    const lanes: Record<CardStatus, Card[]> = { todo: [], running: [], review: [], done: [], failed: [] };
    for (const c of board()?.cards ?? []) lanes[c.status].push(c);
    return lanes;
  });

  onMount(() => void actions.boardOpen(props.root));

  return (
    <section class="board">
      <header class="board-head">
        <div>
          <h1>{projectName(props.root)} board</h1>
          <span class="muted small mono">{board()?.path ?? props.root}</span>
        </div>
        <div class="board-controls">
          <Show
            when={board()?.runCap}
            fallback={
              <>
                <label class="inline">
                  <span class="muted small">at most</span>
                  <select value={cap()} onChange={(e) => setCap(Number(e.currentTarget.value))}>
                    <For each={[1, 2, 3, 4, 5, 8]}>{(n) => <option value={n}>{n}</option>}</For>
                  </select>
                </label>
                <button disabled={byLane().todo.length === 0} onClick={() => void actions.boardRun(props.root, cap())} title="Keep dispatching to-do cards, up to this many at once">
                  Run to-do cards
                </button>
              </>
            }
          >
            {(runCap) => (
              <>
                <span class="chip running-chip">running up to {runCap()}</span>
                <button onClick={() => void actions.boardRun(props.root, null)}>Stop running</button>
              </>
            )}
          </Show>
          <button class="primary" onClick={() => setEditing("new")}>
            New card
          </button>
        </div>
      </header>
      <Show when={board()?.loadError}>
        <div class="notice error">This board file could not be read, so Loom will not change it: {board()!.loadError}</div>
      </Show>
      <div class="lanes">
        <For each={LANES}>
          {(lane) => (
            <div class="lane">
              <header class="lane-head">
                {lane.label} <span class="muted small">{byLane()[lane.id].length}</span>
              </header>
              <For each={byLane()[lane.id]}>{(card) => <CardTile root={props.root} card={card} onEdit={() => setEditing(card)} />}</For>
            </div>
          )}
        </For>
      </div>
      <Show when={editing()}>
        {(target) => <CardEditor root={props.root} card={target() === "new" ? undefined : (target() as Card)} onClose={() => setEditing(undefined)} />}
      </Show>
    </section>
  );
}

function CardTile(props: { root: string; card: Card; onEdit(): void }) {
  const { state, actions } = useHub();
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const session = () => (props.card.sessionId ? state.sessions[props.card.sessionId] : undefined);
  const c = () => props.card;
  return (
    <article class="card" classList={{ blocked: session()?.state === "blocked" }}>
      <div class="card-title">{c().title}</div>
      <div class="card-chips">
        <span class="chip">{KIND_LABEL[c().kind]}</span>
        <Show when={c().worktree}>
          <span class="chip">worktree</span>
        </Show>
        <Show when={session()}>
          {(s) => (
            <button class="link" onClick={() => void actions.open(s().id)}>
              {s().name} · {stateLabel(s().state, s().blockedOn)}
            </button>
          )}
        </Show>
      </div>
      <Show when={c().prompt}>
        <div class="card-prompt">{c().prompt}</div>
      </Show>
      <Show when={c().lastError}>
        <div class="notice error small">{c().lastError}</div>
      </Show>
      <div class="card-actions">
        <Show when={c().status === "todo" || c().status === "failed"}>
          <button class="primary" onClick={() => void actions.boardDispatch(props.root, c().id)}>
            {c().status === "failed" ? "Retry" : "Start"}
          </button>
          <button onClick={() => props.onEdit()}>Edit</button>
        </Show>
        <Show when={c().status === "review"}>
          <button class="primary" onClick={() => void actions.boardMove(props.root, c().id, "done")}>
            Done
          </button>
        </Show>
        <Show when={c().status === "running" || c().status === "review"}>
          <button onClick={() => void actions.boardMove(props.root, c().id, "todo")} title="Back to to-do; the session keeps running">
            Back to to do
          </button>
        </Show>
        <Show when={c().status !== "running"}>
          <Show when={confirmDelete()} fallback={<button class="danger" onClick={() => setConfirmDelete(true)}>Delete</button>}>
            <button class="danger" onClick={() => void actions.boardRemove(props.root, c().id)} onMouseLeave={() => setConfirmDelete(false)}>
              Really delete
            </button>
          </Show>
        </Show>
      </div>
    </article>
  );
}

function CardEditor(props: { root: string; card: Card | undefined; onClose(): void }) {
  const { state, actions } = useHub();
  const [title, setTitle] = createSignal(props.card?.title ?? "");
  const [prompt, setPrompt] = createSignal(props.card?.prompt ?? "");
  const [kind, setKind] = createSignal<CardKind>(props.card?.kind ?? "chat");
  const [model, setModel] = createSignal(props.card?.model ?? "");
  const [level, setLevel] = createSignal<PermissionLevel>(props.card?.level ?? state.hub?.defaultLevel ?? "supervised");
  const [worktree, setWorktree] = createSignal(props.card?.worktree !== undefined);
  const [baseRef, setBaseRef] = createSignal(props.card?.worktree?.baseRef ?? "");

  const submit = async (e: Event) => {
    e.preventDefault();
    const input: CardInput = {
      title: title().trim(),
      prompt: prompt(),
      kind: kind(),
      ...(kind() !== "terminal" && model() ? { model: model() } : {}),
      ...(kind() !== "terminal" ? { level: level() } : {}),
      ...(worktree() ? { worktree: baseRef().trim() ? { baseRef: baseRef().trim() } : {} } : {}),
    };
    const result = props.card ? await actions.boardUpdate(props.root, props.card.id, input) : await actions.boardAdd(props.root, input);
    if (result) props.onClose();
  };

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <form class="dialog" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
        <h2>{props.card ? "Edit card" : "New card"}</h2>
        <label>
          <span>Title</span>
          <input value={title()} onInput={(e) => setTitle(e.currentTarget.value)} required autofocus />
        </label>
        <label>
          <span>Kind</span>
          <select value={kind()} onChange={(e) => setKind(e.currentTarget.value as CardKind)}>
            <For each={Object.entries(KIND_LABEL)}>{([id, label]) => <option value={id}>{label}</option>}</For>
          </select>
        </label>
        <label>
          <span>{kind() === "terminal" ? "Command (empty for a shell)" : "What the session should do"}</span>
          <textarea rows={5} class={kind() === "terminal" ? "mono" : ""} value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} />
        </label>
        <Show when={kind() !== "terminal"}>
          <div class="row">
            <label>
              <span>Model</span>
              <select value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
                <For each={MODEL_CHOICES}>{(m) => <option value={m.id}>{m.label}</option>}</For>
              </select>
            </label>
            <label>
              <span>Permission level</span>
              <LevelSelect stewardOn={state.hub?.stewardModel ?? false} value={level()} max={state.hub?.maxLevel ?? "supervised"} onChange={setLevel} />
            </label>
          </div>
        </Show>
        <label class="inline">
          <input type="checkbox" checked={worktree()} onChange={(e) => setWorktree(e.currentTarget.checked)} />
          <span>Run in its own worktree and branch</span>
        </label>
        <Show when={worktree()}>
          <label>
            <span>Start the branch from (empty for the current HEAD)</span>
            <input class="mono" value={baseRef()} onInput={(e) => setBaseRef(e.currentTarget.value)} placeholder="origin/main" />
          </label>
        </Show>
        <div class="actions end">
          <button type="button" onClick={() => props.onClose()}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={!title().trim()}>
            {props.card ? "Save" : "Add card"}
          </button>
        </div>
      </form>
    </div>
  );
}

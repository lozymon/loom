import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type Hub, HubContext, useHub } from "../hub/store.ts";
import { useHubList } from "../hub/hubList.ts";
import { formatCost, shortPath, stateLabel } from "../lib/format.ts";
import { groupByProject } from "../lib/projects.ts";
import { recentDirs, rememberDir } from "../lib/recentDirs.ts";

/** Every session on every hub at a glance: state, what it did last, what it waits for, what it cost (PLAN §8). */
export function Overview(props: { onNew(hub: Hub): void }) {
  const hubList = useHubList();
  return (
    <section class="overview">
      <For each={hubList.hubs()}>
        {(h) => (
          <HubContext.Provider value={h.hub}>
            <HubOverview named={hubList.hubs().length > 1} label={h.entry.name ?? h.entry.url ?? "Loom hub"} onNew={() => props.onNew(h.hub)} />
          </HubContext.Provider>
        )}
      </For>
    </section>
  );
}

function HubOverview(props: { named: boolean; label: string; onNew(): void }) {
  const { state, actions } = useHub();
  const groups = createMemo(() => groupByProject(Object.values(state.sessions), false));
  const [boardPath, setBoardPath] = createSignal("");
  createEffect(() => {
    // Recent folders are per hub, and the hub id arrives with the welcome.
    if (!boardPath()) setBoardPath(recentDirs(state.hub?.id)[0] ?? "");
  });
  const pendingFor = (id: string) => Object.values(state.approvals).filter((a) => a.sessionId === id).length;
  const counts = createMemo(() => {
    const c = { working: 0, blocked: 0, idle: 0, ended: 0 };
    for (const s of Object.values(state.sessions)) {
      if (s.archived) continue;
      if (s.state === "working" || s.state === "starting") c.working++;
      else if (s.state === "blocked") c.blocked++;
      else if (s.state === "idle") c.idle++;
      else c.ended++;
    }
    return c;
  });

  onMount(() => {
    void actions.refreshStats();
    const timer = setInterval(() => void actions.refreshStats(), 10_000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <div class="overview-hub">
      <header class="overview-head">
        <Show when={props.named} fallback={<h1>Overview</h1>}>
          <h1 class="overview-hub-name">
            <span class={`dot conn-${state.status.kind}`} />
            {state.hub?.name ?? props.label}
          </h1>
        </Show>
        <div class="stats">
          <Stat label="working" value={String(counts().working)} tone="working" />
          <Stat label="need you" value={String(counts().blocked)} tone={counts().blocked ? "blocked" : undefined} />
          <Stat label="idle" value={String(counts().idle)} />
          <Stat label="ended" value={String(counts().ended)} />
          <Stat label="today" value={formatCost(state.stats?.costToday ?? 0)} />
          <Stat label="total" value={formatCost(state.stats?.costTotal ?? 0)} />
          <Show when={state.hub?.stewardModel}>
            <Stat label={`steward (${state.hub?.steward?.mode ?? "on"})`} value={formatCost(state.stats?.stewardCostToday ?? 0)} />
          </Show>
        </div>
      </header>
      <form
        class="open-board"
        onSubmit={(e) => {
          e.preventDefault();
          const dir = boardPath().trim();
          if (!dir) return;
          rememberDir(dir, state.hub?.id);
          void actions.boardOpen(dir, true);
        }}
      >
        <input class="mono" list={`overview-dirs-${state.hub?.id ?? "hub"}`} value={boardPath()} onInput={(e) => setBoardPath(e.currentTarget.value)} placeholder="/path/to/project" aria-label="Project folder" />
        <datalist id={`overview-dirs-${state.hub?.id ?? "hub"}`}>
          <For each={recentDirs(state.hub?.id)}>{(d) => <option value={d} />}</For>
        </datalist>
        <button type="submit" disabled={!boardPath().trim() || state.status.kind !== "open"}>
          Open board
        </button>
      </form>
      <Show
        when={groups().length > 0}
        fallback={
          <div class="empty">
            <p class="muted">{state.status.kind === "open" ? "No sessions yet." : "Not connected."}</p>
            <button class="primary" disabled={state.status.kind !== "open"} onClick={() => props.onNew()}>
              New session
            </button>
          </div>
        }
      >
        <For each={groups()}>
          {(group) => (
            <section class="overview-group">
              <header class="overview-group-head">
                <h2 title={group.root}>{group.name}</h2>
                <button class="link" onClick={() => void actions.boardOpen(group.root, true)}>
                  open board
                </button>
              </header>
              <div class="tiles">
                <For each={group.sessions}>
                  {(s) => (
                    <button class="tile" classList={{ blocked: s.state === "blocked" }} onClick={() => void actions.open(s.id)}>
                      <div class="tile-head">
                        <span class={`dot state-${s.state}`} />
                        <span class="tile-name">{s.name}</span>
                        <span class="muted small">{stateLabel(s.state, s.blockedOn)}</span>
                        <Show when={pendingFor(s.id) > 0}>
                          <span class="badge">{pendingFor(s.id)}</span>
                        </Show>
                      </div>
                      <div class="tile-meta">
                        <Show when={s.branch} fallback={<span>{shortPath(s.cwd)}</span>}>
                          <span class="branch">{s.branch}</span>
                        </Show>
                        <Show when={s.adapter === "pty"} fallback={<span>{formatCost(s.costUsd)}</span>}>
                          <span>{s.agent ? `${s.agent} terminal` : "terminal"}</span>
                        </Show>
                      </div>
                      <div class="tile-activity">{s.activity ?? s.subtitle ?? s.command ?? "—"}</div>
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function Stat(props: { label: string; value: string; tone?: "working" | "blocked" | undefined }) {
  return (
    <div class="stat" classList={{ [`tone-${props.tone}`]: props.tone !== undefined }}>
      <span class="stat-value">{props.value}</span>
      <span class="stat-label">{props.label}</span>
    </div>
  );
}

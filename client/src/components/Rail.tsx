import type { SessionSummary } from "@loom/protocol";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { HubDialog } from "../App.tsx";
import { HubContext, useHub } from "../hub/store.ts";
import { useHubList } from "../hub/hubList.ts";
import { formatCost, stateLabel } from "../lib/format.ts";
import { groupByProject } from "../lib/projects.ts";
import { VoiceBar } from "./VoiceBar.tsx";

export function Rail(props: { open(dialog: HubDialog): void; drawerOpen: boolean; onNavigate(): void }) {
  const hubList = useHubList();
  const pending = createMemo(() => hubList.hubs().reduce((n, h) => n + Object.keys(h.hub.state.approvals).length, 0));
  const onOverview = () => hubList.active()?.hub.state.screen.kind === "overview";

  return (
    <nav
      class="rail"
      classList={{ "drawer-open": props.drawerOpen }}
      onClick={(e) => {
        // On a phone the rail is a drawer: going somewhere closes it.
        if ((e.target as HTMLElement).closest(".rail-item, .rail-actions button, .rail-group-head .link, .approvals-button, .cockpit-start, .rail-hub-actions button, .rail-menu button")) props.onNavigate();
      }}
    >
      <div class="rail-actions">
        <button classList={{ active: onOverview() }} onClick={() => hubList.active()?.hub.actions.showOverview()}>
          Overview
        </button>
        <button onClick={() => props.open({ kind: "search" })} title="Search history (Ctrl+K)" aria-label="Search history">
          ⌕
        </button>
        <button onClick={() => props.open({ kind: "add-hub" })} title="Connect to another hub">
          + Hub
        </button>
      </div>
      <Show when={pending() > 0}>
        <button class="wide approvals-button" onClick={() => props.open({ kind: "approvals" })}>
          Approvals <span class="badge">{pending()}</span>
        </button>
      </Show>
      <div class="rail-scroll">
        <For each={hubList.hubs()}>
          {(h) => (
            <HubContext.Provider value={h.hub}>
              <RailHub
                onNew={() => props.open({ kind: "new-session", hub: h.hub })}
                onToken={() => props.open({ kind: "add-hub", url: h.entry.url })}
                onPhone={() => props.open({ kind: "phone", hub: h.hub })}
              />
            </HubContext.Provider>
          )}
        </For>
      </div>
      <VoiceBar />
    </nav>
  );
}

/** One hub in the rail: its header, Cockpit, and sessions by project. */
function RailHub(props: { onNew(): void; onToken(): void; onPhone(): void }) {
  const hubList = useHubList();
  const hub = useHub();
  const { state, actions } = hub;
  const entry = () => hubList.entryOf(hub);
  const groups = createMemo(() => groupByProject(Object.values(state.sessions), state.showArchived));
  const total = createMemo(() => Object.values(state.sessions).reduce((sum, s) => sum + s.costUsd, 0));
  const pendingFor = (id: string) => Object.values(state.approvals).filter((a) => a.sessionId === id).length;
  const archivedCount = () => Object.values(state.sessions).filter((s) => s.archived).length;
  const cockpit = createMemo(() => Object.values(state.sessions).find((s) => s.cockpit && !s.archived));
  const [menu, setMenu] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);

  const statusText = () => {
    const s = state.status;
    switch (s.kind) {
      case "open":
        return "connected";
      case "connecting":
        return "connecting…";
      case "retrying":
        return `reconnecting in ${Math.round(s.inMs / 100) / 10}s`;
      case "refused":
        return "refused";
    }
  };

  let head!: HTMLDivElement;
  createEffect(() => {
    if (!menu()) return;
    const onDown = (e: PointerEvent) => {
      if (!head.contains(e.target as Node)) {
        setMenu(false);
        setConfirmRemove(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDown));
  });

  return (
    <section class="rail-hub-section" classList={{ current: hubList.hubs().length > 1 && hubList.isActive(hub) }}>
      <div class="rail-hub rail-row" ref={head}>
        <span class={`dot conn-${state.status.kind}`} />
        <div class="rail-hub-text">
          <div class="rail-hub-name">{state.hub?.name ?? entry()?.name ?? "Loom hub"}</div>
          <div class="muted small" title={entry()?.url ?? "the hub serving this page"}>
            {statusText()} · {formatCost(total())}
            <Show when={entry()?.url}>{(url) => <> · {url().replace(/^https?:\/\//, "")}</>}</Show>
          </div>
        </div>
        <button class="rail-menu-button" aria-label="Hub actions" onClick={() => setMenu((v) => !v)}>
          ⋯
        </button>
        <Show when={menu()}>
          <div class="rail-menu" role="menu">
            <button
              onClick={() => {
                setMenu(false);
                props.onToken();
              }}
            >
              Change token…
            </button>
            <button
              onClick={() => {
                setMenu(false);
                props.onPhone();
              }}
            >
              Phone and notifications…
            </button>
            <Show when={confirmRemove()} fallback={<button onClick={() => setConfirmRemove(true)}>Remove from this client…</button>}>
              <button class="danger" onClick={() => hubList.remove(entry()!.key)} title="The hub and its sessions keep running.">
                Remove {state.hub?.name ?? "hub"}
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <div class="rail-hub-actions">
        <button class="primary" onClick={() => props.onNew()} disabled={state.status.kind !== "open"}>
          New session
        </button>
      </div>
      <Show
        when={cockpit()}
        fallback={
          <button class="wide cockpit-start" disabled={state.status.kind !== "open"} onClick={() => void actions.startCockpit()} title="A Claude session that can see and run every other session on this hub">
            ✦ Start Cockpit
          </button>
        }
      >
        {(c) => (
          <ul class="rail-list cockpit-row">
            <RailItem session={c()} pending={pendingFor(c().id)} />
          </ul>
        )}
      </Show>
      <For each={groups()}>
        {(group) => (
          <section class="rail-group">
            <header class="rail-group-head" title={group.root}>
              <span class="rail-group-name">{group.name}</span>
              <button
                class="link"
                classList={{ active: hubList.isActive(hub) && state.screen.kind === "board" && state.screen.root === group.root }}
                onClick={() => void actions.boardOpen(group.root, true)}
              >
                board
              </button>
            </header>
            <ul class="rail-list">
              <For each={group.sessions}>{(s) => <RailItem session={s} pending={pendingFor(s.id)} />}</For>
            </ul>
          </section>
        )}
      </For>
      <Show when={archivedCount() > 0}>
        <button class="link rail-archived" onClick={() => actions.toggleArchived()}>
          {state.showArchived ? "Hide archived" : `Show archived (${archivedCount()})`}
        </button>
      </Show>
    </section>
  );
}

function RailItem(props: { session: SessionSummary; pending: number }) {
  const hubList = useHubList();
  const hub = useHub();
  const { state, actions } = hub;
  // No window.prompt or window.confirm: blocking dialogs freeze the desktop webview (v1 lesson).
  const [menu, setMenu] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const s = () => props.session;

  const closeMenu = () => {
    setMenu(false);
    setConfirmRemove(false);
  };
  let row!: HTMLLIElement;
  // Close on a click outside the row or on Escape. Not on mouse leave, which fights two-step confirms.
  createEffect(() => {
    if (!menu()) return;
    const onDown = (e: PointerEvent) => {
      if (!row.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
  const archive = (removeWorktree: boolean) => {
    closeMenu();
    void actions.archive(s().id, removeWorktree);
  };

  return (
    <li class="rail-row" ref={row}>
      <Show when={renaming()}>
        <form
          class="rail-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const name = new FormData(e.currentTarget).get("name")?.toString().trim();
            setRenaming(false);
            if (name && name !== s().name) void actions.rename(s().id, name);
          }}
        >
          <input name="name" value={s().name} autofocus onBlur={() => setRenaming(false)} onKeyDown={(e) => e.key === "Escape" && setRenaming(false)} />
        </form>
      </Show>
      <button
        class="rail-item"
        classList={{ hidden: renaming(), active: hubList.isActive(hub) && state.screen.kind === "session" && state.selected === s().id, paused: !s().live, archived: s().archived }}
        onClick={() => void actions.open(s().id)}
        title={`${s().name}: ${stateLabel(s().state, s().blockedOn)}`}
      >
        <span class={`dot state-${s().state}`} />
        <span class="rail-item-text">
          <span class="rail-item-name">
            {s().name}
            <Show when={s().cockpit}>
              <span class="kind cockpit-mark">✦ cockpit</span>
            </Show>
            <Show when={s().adapter === "pty"}>
              <span class="kind">{s().agent ? `${s().agent} ›_` : "›_"}</span>
            </Show>
            <Show when={s().branch}>
              <span class="branch" title={s().worktree?.removed ? "worktree removed" : s().worktree?.path}>
                {s().branch}
              </span>
            </Show>
          </span>
          <span class="rail-item-sub">{s().subtitle ?? s().command ?? s().cwd}</span>
        </span>
        <Show when={props.pending > 0} fallback={<span class="muted small">{s().adapter === "pty" ? "" : formatCost(s().costUsd)}</span>}>
          <span class="badge">{props.pending}</span>
        </Show>
      </button>
      <button class="rail-menu-button" aria-label={`Actions for ${s().name}`} onClick={() => setMenu((v) => !v)}>
        ⋯
      </button>
      <Show when={menu()}>
        <div class="rail-menu" role="menu">
          <button
            onClick={() => {
              closeMenu();
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <Show
            when={!s().archived}
            fallback={
              <button
                onClick={() => {
                  closeMenu();
                  void actions.unarchive(s().id);
                }}
              >
                Unarchive
              </button>
            }
          >
            <button onClick={() => archive(false)}>Archive</button>
            <Show when={s().worktree && !s().worktree!.removed}>
              <Show
                when={confirmRemove()}
                fallback={<button onClick={() => setConfirmRemove(true)}>Archive and remove worktree…</button>}
              >
                <button class="danger" onClick={() => archive(true)} title="The branch is kept. Uncommitted changes make this fail.">
                  Remove worktree for {s().branch}
                </button>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </li>
  );
}

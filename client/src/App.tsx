import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { AddHub } from "./components/AddHub.tsx";
import { PhoneDialog } from "./components/PhoneDialog.tsx";
import { SearchDialog } from "./components/SearchDialog.tsx";
import { ApprovalsPanel } from "./components/ApprovalsPanel.tsx";
import { Board } from "./components/Board.tsx";
import { NewSession } from "./components/NewSession.tsx";
import { Overview } from "./components/Overview.tsx";
import { Rail } from "./components/Rail.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { type Hub, HubContext } from "./hub/store.ts";
import { createHubList, takeTokenFromHash, useHubList, HubListContext } from "./hub/hubList.ts";
import { createVoice, VoiceContext } from "./voice/controller.ts";

export function App() {
  const hubList = createHubList(localStorage, window.location);
  const fromHash = takeTokenFromHash(window.location);
  if (fromHash) hubList.add(undefined, fromHash.token, fromHash.volatile);
  else hubList.start();

  // Pasting a new link into an open tab only changes the hash, which does not reload the page.
  const onHash = () => {
    const fresh = takeTokenFromHash(window.location);
    if (fresh) hubList.add(undefined, fresh.token, fresh.volatile);
  };
  const voice = createVoice(hubList);
  // Push-to-talk: hold Ctrl+Shift+Space while the page has focus. Escape stops read-back.
  const isTalkKey = (e: KeyboardEvent) => e.code === "Space" && e.ctrlKey && e.shiftKey;
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTalkKey(e)) {
      e.preventDefault();
      if (!e.repeat) void voice.press();
    } else if (e.key === "Escape" && voice.speaker.speaking()) {
      voice.speaker.stop();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" || e.key === "Control" || e.key === "Shift") void voice.release();
  };
  const onBlur = () => void voice.release();
  // The desktop app (M9) calls these: its global shortcut works while Loom is not focused.
  (window as unknown as { loomDesktop: unknown }).loomDesktop = {
    pushToTalk: (down: boolean) => void (down ? voice.press() : voice.release()),
    attached: () => {
      if (typeof Notification !== "undefined" && Notification.permission === "default" && voice.settings.notify) void Notification.requestPermission();
    },
  };
  onMount(() => {
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  });
  onCleanup(() => {
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    voice.speaker.stop();
    hubList.stop();
  });

  return (
    <HubListContext.Provider value={hubList}>
      <VoiceContext.Provider value={voice}>
        <Show when={hubList.hubs().length > 0} fallback={<AddHub first />}>
          <Shell />
        </Show>
      </VoiceContext.Provider>
    </HubListContext.Provider>
  );
}

export type HubDialog =
  | { kind: "new-session"; hub: Hub }
  | { kind: "add-hub"; url?: string | undefined }
  | { kind: "approvals"; focus?: string | undefined }
  | { kind: "phone"; hub: Hub }
  | { kind: "search" };

/** `#approval=<id>`, as a notification opens it. Removes it from the address bar. */
function takeApprovalFromHash(): string | undefined {
  const match = /(?:^#|&)approval=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return undefined;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]);
}

function Shell() {
  const [dialog, setDialog] = createSignal<HubDialog>();
  const [drawer, setDrawer] = createSignal(false);
  const hubList = useHubList();
  const pendingCount = () => hubList.hubs().reduce((n, h) => n + Object.keys(h.hub.state.approvals).length, 0);
  const openApproval = (id: string | undefined) => {
    if (!id) return;
    setDrawer(false);
    setDialog({ kind: "approvals", focus: id });
  };
  openApproval(takeApprovalFromHash());
  const onHash = () => openApproval(takeApprovalFromHash());
  const onWorkerMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; hash?: string } | undefined;
    if (data?.type === "loom-open" && data.hash) openApproval(/approval=([^&]+)/.exec(data.hash)?.[1]);
  };
  // Ctrl+K (Cmd+K) searches history from anywhere.
  const onSearchKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setDialog({ kind: "search" });
    }
  };
  onMount(() => {
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onSearchKey);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
  });
  onCleanup(() => {
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onSearchKey);
    navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
  });
  const phoneFor = () => {
    const d = dialog();
    return d?.kind === "phone" ? d.hub : undefined;
  };
  const close = () => setDialog(undefined);
  const creatingOn = () => {
    const d = dialog();
    return d?.kind === "new-session" ? d.hub : undefined;
  };

  return (
    <div class="app">
      <header class="mobile-bar">
        <button class="mobile-menu" aria-label="Open the menu" onClick={() => setDrawer(true)}>
          ☰
        </button>
        <span class="mobile-title">
          <span class={`dot conn-${hubList.active()?.hub.state.status.kind ?? "connecting"}`} /> {hubList.active()?.hub.state.hub?.name ?? "Loom"}
        </span>
        <button class="mobile-menu" aria-label="Search history" onClick={() => setDialog({ kind: "search" })}>
          ⌕
        </button>
        <Show when={pendingCount() > 0}>
          <button class="approvals-button" onClick={() => setDialog({ kind: "approvals" })}>
            Need you <span class="badge">{pendingCount()}</span>
          </button>
        </Show>
      </header>
      <Show when={drawer()}>
        <div class="drawer-backdrop" onClick={() => setDrawer(false)} />
      </Show>
      <Rail open={setDialog} drawerOpen={drawer()} onNavigate={() => setDrawer(false)} />
      <main class="main">
        <Show when={hubList.notice()}>
          <div class="banner">
            {hubList.notice()}
            <button onClick={() => hubList.dismissNotice()}>Dismiss</button>
          </div>
        </Show>
        <For each={hubList.hubs()}>
          {(h) => (
            <>
              <Show when={h.hub.state.status.kind === "refused" && h.hub.state.status}>
                {(refused) => (
                  <div class="banner error">
                    {hubList.hubs().length > 1 ? `${h.hub.state.hub?.name ?? h.entry.name ?? h.entry.url ?? "This hub"}: ` : ""}
                    {refused().reason}
                    <button onClick={() => setDialog({ kind: "add-hub", url: h.entry.url })}>Enter a different token</button>
                  </div>
                )}
              </Show>
              <Show when={h.hub.state.error && creatingOn() !== h.hub}>
                <div class="banner error">
                  {hubList.hubs().length > 1 ? `${h.hub.state.hub?.name ?? "Hub"}: ` : ""}
                  {h.hub.state.error}
                  <button onClick={() => h.hub.actions.dismissError()}>Dismiss</button>
                </div>
              </Show>
            </>
          )}
        </For>
        <Show when={hubList.active()} keyed>
          {(active) => (
            <HubContext.Provider value={active.hub}>
              <Show when={active.hub.state.screen.kind === "overview"}>
                <Overview onNew={(hub) => setDialog({ kind: "new-session", hub })} />
              </Show>
              <Show when={active.hub.state.screen.kind === "board" && active.hub.state.screen}>{(screen) => <Board root={screen().root} />}</Show>
              <Show when={active.hub.state.screen.kind === "session" && active.hub.state.selected}>{(id) => <SessionView sessionId={id()} />}</Show>
            </HubContext.Provider>
          )}
        </Show>
      </main>
      <Show when={dialog()?.kind === "approvals" && (dialog() as { focus?: string })} keyed>
        {(d) => <ApprovalsPanel onClose={close} focus={d.focus} />}
      </Show>
      <Show when={dialog()?.kind === "search"}>
        <SearchDialog onClose={close} />
      </Show>
      <Show when={phoneFor()} keyed>
        {(hub) => <PhoneDialog hub={hub} onClose={close} />}
      </Show>
      <Show when={creatingOn()} keyed>
        {(hub) => (
          <HubContext.Provider value={hub}>
            <NewSession
              onClose={() => {
                hub.actions.dismissError();
                close();
              }}
            />
          </HubContext.Provider>
        )}
      </Show>
      <Show when={dialog()?.kind === "add-hub" && (dialog() as { url?: string })} keyed>
        {(d) => <AddHub url={d.url} onClose={close} />}
      </Show>
    </div>
  );
}

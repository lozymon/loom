import { createContext, createSignal, useContext } from "solid-js";
import type { ApprovalRequest, HubEvent, SessionSummary } from "@loom/protocol";
import { createHub, type Hub } from "./store.ts";
import { duplicateOf, type HubEntry, type KeyValueStore, loadHubs, saveHubs, socketUrl, upsertHub } from "./registry.ts";

export interface ListedHub {
  entry: HubEntry;
  hub: Hub;
}

/**
 * Every hub this client is connected to (M7). Each hub keeps its own store and connection; the list
 * owns the list, which hub the main area shows, and the saved addresses and tokens.
 */
export function createHubList(storage: KeyValueStore, page: Pick<Location, "protocol" | "host">) {
  const [hubs, setHubs] = createSignal<ListedHub[]>([]);
  const [activeKey, setActiveKey] = createSignal<string | undefined>();
  const [notice, setNotice] = createSignal<string | undefined>();
  let entries = loadHubs(storage);
  type Listener = (hub: Hub, event: HubEvent, ctx: { before: SessionSummary | undefined; approval: ApprovalRequest | undefined }) => void;
  const listeners = new Set<Listener>();

  const persist = () => saveHubs(storage, entries);

  function start(entry: HubEntry): ListedHub {
    const hub: Hub = createHub(socketUrl(entry.url, page), entry.token, {
      onFocus: () => setActiveKey(entry.key),
      onEvent: (event, ctx) => {
        for (const l of listeners) l(hub, event, ctx);
      },
      onWelcome: (welcome) => {
        const dup = duplicateOf(entries, entry.key, welcome.hub.id);
        if (dup) {
          setNotice(`"${welcome.hub.name}" is already connected${dup.url ? ` at ${dup.url}` : ""}. Using that one.`);
          remove(entry.key);
          setActiveKey(dup.key);
          return;
        }
        entries = entries.map((e) => (e.key === entry.key ? { ...e, hubId: welcome.hub.id, name: welcome.hub.name } : e));
        persist();
      },
    });
    hub.actions.connect();
    return { entry, hub };
  }

  /** Brings running hubs in line with `entries`: starts new ones, restarts changed ones, stops removed ones. */
  function reconcileHubs(): void {
    const running = new Map(hubs().map((h) => [h.entry.key, h]));
    const next = entries.map((entry) => {
      const current = running.get(entry.key);
      running.delete(entry.key);
      if (current && current.entry.url === entry.url && current.entry.token === entry.token) {
        return { ...current, entry };
      }
      current?.hub.actions.disconnect();
      return start(entry);
    });
    for (const gone of running.values()) gone.hub.actions.disconnect();
    setHubs(next);
    if (!next.some((h) => h.entry.key === activeKey())) setActiveKey(next[0]?.entry.key);
  }

  function add(url: string | undefined, token: string, volatile = false): string {
    const result = upsertHub(entries, url, token, () => crypto.randomUUID(), volatile);
    entries = result.hubs;
    persist();
    reconcileHubs();
    setActiveKey(result.key);
    return result.key;
  }

  function remove(key: string): void {
    entries = entries.filter((e) => e.key !== key);
    persist();
    reconcileHubs();
  }

  return {
    hubs,
    notice,
    dismissNotice: () => setNotice(undefined),
    active: () => hubs().find((h) => h.entry.key === activeKey()),
    isActive: (hub: Hub) => hubs().find((h) => h.hub === hub)?.entry.key === activeKey(),
    entryOf: (hub: Hub) => hubs().find((h) => h.hub === hub)?.entry,
    add,
    remove,
    /** Live events from every hub. Returns an unsubscribe function. */
    onEvent(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => reconcileHubs(),
    stop: () => {
      for (const h of hubs()) h.hub.actions.disconnect();
    },
  };
}

export type HubList = ReturnType<typeof createHubList>;

export const HubListContext = createContext<HubList>();

export function useHubList(): HubList {
  const ws = useContext(HubListContext);
  if (!ws) throw new Error("useHubList must be used inside a HubListContext provider");
  return ws;
}

/**
 * A token in `#token=…` belongs to the hub serving this page. `&once=1` marks a token for this page
 * load only (the desktop app's). Removes both from the address bar.
 */
export function takeTokenFromHash(location: Location): { token: string; volatile: boolean } | undefined {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!match?.[1]) return undefined;
  const volatile = /(?:^#|&)once=1(?:&|$)/.test(location.hash);
  history.replaceState(null, "", location.pathname + location.search);
  return { token: decodeURIComponent(match[1]), volatile };
}

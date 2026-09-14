/**
 * The hubs this client knows (M7): where each one is and the token for it, kept in localStorage.
 * The hub serving the page (or the dev proxy) has no URL of its own; it is the "page" hub.
 */

export interface HubEntry {
  /** Local key, stable across renames. */
  key: string;
  /** `http(s)://host:port` of the hub, or undefined for the hub serving this page. */
  url: string | undefined;
  token: string;
  /** From the hub's welcome, once connected: identifies the same hub reached by two addresses. */
  hubId?: string;
  /** Last known display name, for showing the hub before it connects. */
  name?: string;
  /** For this page load only, never saved: the desktop app's one-run sign-in token (M9). */
  volatile?: boolean;
}

const KEY = "loom.hubs";
const LEGACY_TOKEN_KEY = "loom.token";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readSaved(storage: KeyValueStore): HubEntry[] | undefined {
  const raw = storage.getItem(KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    // A damaged list is treated as empty rather than breaking the client.
    return [];
  }
}

export function loadHubs(storage: KeyValueStore): HubEntry[] {
  const saved = readSaved(storage);
  if (saved) return saved;
  // M1–M6 kept one token for the page hub.
  const legacy = storage.getItem(LEGACY_TOKEN_KEY);
  if (!legacy) return [];
  const hubs = [{ key: "page", url: undefined, token: legacy }];
  saveHubs(storage, hubs);
  storage.removeItem(LEGACY_TOKEN_KEY);
  return hubs;
}

/** Saves the list. A volatile entry keeps whatever was saved under its key before, or is left out. */
export function saveHubs(storage: KeyValueStore, hubs: HubEntry[]): void {
  const before = new Map((readSaved(storage) ?? []).map((h) => [h.key, h]));
  const kept = hubs.flatMap((h) => (h.volatile ? (before.has(h.key) ? [before.get(h.key)!] : []) : [h]));
  storage.setItem(KEY, JSON.stringify(kept.map((h) => ({ ...h, url: h.url ?? null }))));
}

function isEntry(v: unknown): v is HubEntry {
  const e = v as Record<string, unknown>;
  if (typeof e?.key !== "string" || typeof e.token !== "string") return false;
  if (e.url === null) e.url = undefined;
  return e.url === undefined || typeof e.url === "string";
}

export type ParsedHubInput = { ok: true; url: string | undefined; token: string } | { ok: false; error: string };

/**
 * Reads what someone pasted: a link the hub printed (`http://host:7420/#token=…`), or an address and a
 * token typed separately. An empty address means the hub serving this page.
 */
export function parseHubInput(address: string, token: string): ParsedHubInput {
  let a = address.trim();
  let t = token.trim();
  const inLink = /#(?:.*&)?token=([^&]+)/.exec(a);
  if (inLink?.[1]) {
    t ||= decodeURIComponent(inLink[1]);
    a = a.slice(0, a.indexOf("#"));
  }
  if (!t) return { ok: false, error: "Paste the hub's link, or its address and access token." };
  if (!a) return { ok: true, url: undefined, token: t };
  if (!/^[a-z]+:\/\//i.test(a)) a = `http://${a}`;
  let parsed: URL;
  try {
    parsed = new URL(a);
  } catch {
    return { ok: false, error: `Not an address: ${address.trim()}` };
  }
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: `Unsupported address: ${address.trim()}` };
  return { ok: true, url: parsed.origin, token: t };
}

/** WebSocket endpoint for an entry. */
export function socketUrl(url: string | undefined, page: Pick<Location, "protocol" | "host">): string {
  if (url === undefined) return `${page.protocol === "https:" ? "wss:" : "ws:"}//${page.host}/ws`;
  const u = new URL(url);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/ws`;
}

/** Adds or updates a hub. The same address replaces the old token instead of adding a second entry. */
export function upsertHub(hubs: HubEntry[], url: string | undefined, token: string, newKey: () => string, volatile = false): { hubs: HubEntry[]; key: string } {
  const flag = volatile ? { volatile: true } : {};
  const same = hubs.find((h) => h.url === url);
  if (same) {
    const { volatile: _old, ...rest } = same;
    return { hubs: hubs.map((h) => (h === same ? { ...rest, token, ...flag } : h)), key: same.key };
  }
  const key = url === undefined && !hubs.some((h) => h.key === "page") ? "page" : newKey();
  return { hubs: [...hubs, { key, url, token, ...flag }], key };
}

/** The entry that already reaches `hubId` through another address, if any. */
export function duplicateOf(hubs: HubEntry[], key: string, hubId: string): HubEntry | undefined {
  return hubs.find((h) => h.key !== key && h.hubId === hubId);
}

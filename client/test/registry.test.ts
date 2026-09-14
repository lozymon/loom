import { describe, expect, it } from "vitest";
import { duplicateOf, type HubEntry, loadHubs, parseHubInput, saveHubs, socketUrl, upsertHub } from "../src/hub/registry.ts";

function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("hub registry", () => {
  it("moves the single M1–M6 token into the list", () => {
    const store = memory({ "loom.token": "abc" });
    expect(loadHubs(store)).toEqual([{ key: "page", url: undefined, token: "abc" }]);
    expect(store.data.has("loom.token")).toBe(false);
    expect(loadHubs(store)).toEqual([{ key: "page", url: undefined, token: "abc" }]);
  });

  it("round-trips entries and survives damage", () => {
    const store = memory();
    const hubs: HubEntry[] = [
      { key: "page", url: undefined, token: "a" },
      { key: "k2", url: "http://127.0.0.1:17420", token: "b", hubId: "hub-2", name: "work" },
    ];
    saveHubs(store, hubs);
    expect(loadHubs(store)).toEqual(hubs);
    expect(loadHubs(memory({ "loom.hubs": "{nope" }))).toEqual([]);
  });

  it("reads a printed link, an address with a token, and a bare token", () => {
    expect(parseHubInput("http://100.70.1.2:7420/#token=t%2B1", "")).toEqual({ ok: true, url: "http://100.70.1.2:7420", token: "t+1" });
    expect(parseHubInput("127.0.0.1:17420", " tok ")).toEqual({ ok: true, url: "http://127.0.0.1:17420", token: "tok" });
    expect(parseHubInput("ws://work:7420/ws", "tok")).toEqual({ ok: true, url: "http://work:7420", token: "tok" });
    expect(parseHubInput("", "tok")).toEqual({ ok: true, url: undefined, token: "tok" });
    expect(parseHubInput("http://work:7420", "")).toMatchObject({ ok: false });
    expect(parseHubInput("ftp://work", "t")).toMatchObject({ ok: false });
  });

  it("builds socket URLs", () => {
    expect(socketUrl(undefined, { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/ws");
    expect(socketUrl("https://hub.tail1234.ts.net", { protocol: "http:", host: "x" })).toBe("wss://hub.tail1234.ts.net/ws");
    expect(socketUrl("http://127.0.0.1:17420", { protocol: "https:", host: "x" })).toBe("ws://127.0.0.1:17420/ws");
  });

  it("updates the token for a known address instead of adding it twice", () => {
    let n = 0;
    const key = () => `k${++n}`;
    let r = upsertHub([], undefined, "a", key);
    expect(r).toEqual({ hubs: [{ key: "page", url: undefined, token: "a" }], key: "page" });
    r = upsertHub(r.hubs, "http://work:7420", "b", key);
    r = upsertHub(r.hubs, "http://work:7420", "c", key);
    expect(r.hubs).toEqual([
      { key: "page", url: undefined, token: "a" },
      { key: "k1", url: "http://work:7420", token: "c" },
    ]);
  });

  it("never saves a volatile token, and keeps what was saved under that key", () => {
    const store = memory();
    let r = upsertHub([], undefined, "saved", () => "k");
    saveHubs(store, r.hubs);
    r = upsertHub(r.hubs, undefined, "desktop-once", () => "k", true);
    expect(r.hubs[0]).toMatchObject({ token: "desktop-once", volatile: true });
    saveHubs(store, r.hubs);
    expect(loadHubs(store)).toEqual([{ key: "page", url: undefined, token: "saved" }]);
    saveHubs(store, upsertHub([], undefined, "once", () => "k", true).hubs.map((h) => ({ ...h, key: "other" })));
    expect(loadHubs(store)).toEqual([]);
    r = upsertHub(r.hubs, undefined, "typed", () => "k");
    expect(r.hubs[0]).toEqual({ key: "page", url: undefined, token: "typed" });
  });

  it("finds the same hub under another address", () => {
    const hubs: HubEntry[] = [
      { key: "a", url: "http://127.0.0.1:17420", token: "t", hubId: "h1" },
      { key: "b", url: "http://100.70.1.2:7420", token: "t" },
    ];
    expect(duplicateOf(hubs, "b", "h1")?.key).toBe("a");
    expect(duplicateOf(hubs, "a", "h1")).toBeUndefined();
  });
});

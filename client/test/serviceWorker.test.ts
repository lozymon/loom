import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** Runs public/sw.js against a fake service worker global and returns its event handlers. */
function loadWorker(windows: Array<{ url: string; postMessage(m: unknown): void; focus(): Promise<unknown> }> = []) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://pc.tailnet.ts.net" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    skipWaiting: () => undefined,
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { claim: async () => undefined, matchAll: async () => windows, openWindow: async (url: string) => void opened.push(url) },
  };
  vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "..", "public", "sw.js"), "utf8"), { self, URL });
  const fire = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  return { fire, shown, opened };
}

describe("service worker", () => {
  it("shows the pushed notification with a same-origin link only", async () => {
    const w = loadWorker();
    await w.fire("push", { data: { json: () => ({ title: "Loom", body: "Faye needs approval: Run: git push", tag: "approval-a1", url: "/#approval=a1" }) } });
    expect(w.shown[0]).toMatchObject({ title: "Loom", options: { body: "Faye needs approval: Run: git push", tag: "approval-a1", data: { url: "/#approval=a1" } } });
    await w.fire("push", { data: { json: () => ({ body: "x", url: "https://evil.example/" }) } });
    expect(w.shown[1]!.options.data).toEqual({ url: "/" });
    await w.fire("push", { data: { json: () => { throw new Error("not json"); }, text: () => "plain text" } });
    expect(w.shown[2]!.options.body).toBe("plain text");
  });

  it("focuses an open window and tells it which approval, or opens one", async () => {
    const messages: unknown[] = [];
    let focused = false;
    const open = { url: "https://pc.tailnet.ts.net/", postMessage: (m: unknown) => messages.push(m), focus: async () => (focused = true) };
    const withWindow = loadWorker([open]);
    const notification = { close: () => undefined, data: { url: "/#approval=a1" } };
    await withWindow.fire("notificationclick", { notification });
    expect(messages).toEqual([{ type: "loom-open", hash: "#approval=a1" }]);
    expect(focused).toBe(true);

    const none = loadWorker();
    await none.fire("notificationclick", { notification });
    expect(none.opened).toEqual(["https://pc.tailnet.ts.net/#approval=a1"]);
  });
});

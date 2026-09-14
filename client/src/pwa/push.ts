import type { Hub } from "../hub/store.ts";

/** Why this browser cannot receive push, or undefined when it can. */
export function pushUnavailableReason(): string | undefined {
  if (!window.isSecureContext) return "Notifications need https. Open Loom through tailscale serve or the hub's TLS address.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    return /iPhone|iPad/.test(navigator.userAgent)
      ? "On iPhone and iPad, add Loom to the Home Screen first, then open it from there."
      : "This browser does not support push notifications.";
  }
  return undefined;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: ArrayBuffer | null): string {
  if (!bytes) return "";
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A readable name for this device, e.g. "Android, Chrome". */
export function deviceLabel(ua: string = navigator.userAgent): string {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os}, ${browser}`;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushUnavailableReason()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes with this hub's key (replacing another hub's), and registers the device. */
export async function enablePush(hub: Hub): Promise<void> {
  const reason = pushUnavailableReason();
  if (reason) throw new Error(reason);
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await hub.actions.pushKey();
  const key = base64UrlToBytes(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing && bytesToBase64Url(existing.options.applicationServerKey) !== publicKey) await existing.unsubscribe();
  let sub: PushSubscription;
  try {
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("This browser could not reach its push service. Private windows and Chromium builds without Google services cannot get notifications.");
    }
    throw err;
  }
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await hub.actions.pushSubscribe({ endpoint: json.endpoint, keys: json.keys }, deviceLabel());
}

export async function disablePush(hub: Hub): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await hub.actions.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

/** Registers the service worker where the browser allows one. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("service worker not registered:", err));
}

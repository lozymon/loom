// Persisted pairing: the LAN bridge URL + the 32-byte key. The key is a SECRET (it seals every
// frame, incl. `read`'s scrollback), so it lives in expo-secure-store — Android Keystore-backed —
// never in plain AsyncStorage. Mirrors ADR-0012's "Keystore for the Device key" intent, adapted for
// the local-first path. Re-pairing (a fresh QR from the laptop) overwrites it; forget() revokes.

import * as SecureStore from "expo-secure-store";
import type { PairingInfo } from "../protocol";
import { b64ToBytes } from "../lib/lanClient";

const URL_KEY = "loom.pairing.url";
const KEY_KEY = "loom.pairing.key"; // base64 of 32 bytes

export interface Pairing {
  url: string;
  key: Uint8Array;
}

/** Parse the QR/paste payload (Rust `PairingInfo` JSON) and persist it securely. */
export async function savePairing(info: PairingInfo): Promise<Pairing> {
  await SecureStore.setItemAsync(URL_KEY, info.url);
  await SecureStore.setItemAsync(KEY_KEY, info.key);
  return { url: info.url, key: b64ToBytes(info.key) };
}

/** Load the stored pairing, or null if this device isn't paired yet. */
export async function loadPairing(): Promise<Pairing | null> {
  const url = await SecureStore.getItemAsync(URL_KEY);
  const key = await SecureStore.getItemAsync(KEY_KEY);
  if (!url || !key) return null;
  return { url, key: b64ToBytes(key) };
}

/** Revoke this device's pairing (on lost-phone or re-pair). */
export async function forgetPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(URL_KEY);
  await SecureStore.deleteItemAsync(KEY_KEY);
}

/** Parse a scanned/pasted pairing payload into `PairingInfo`, tolerating either the raw JSON or a
 *  `loom://pair?...` wrapper. Throws on anything unrecognisable. */
export function parsePairingPayload(raw: string): PairingInfo {
  const text = raw.trim();
  const json = text.startsWith("{") ? text : decodeURIComponent(text.replace(/^loom:\/\/pair\?d=/, ""));
  const info = JSON.parse(json) as PairingInfo;
  if (!info.url || !info.key) throw new Error("not a Loom pairing code");
  return info;
}

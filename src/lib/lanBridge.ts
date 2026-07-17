// Frontend client for the LAN bridge (Plan 02 L1c/L2) — thin invoke wrappers over the Rust commands
// (src-tauri/src/lanbridge.rs). This is the laptop side of pairing: enable the bridge (mint/persist a
// key, bind the LAN), show the QR the phone scans, and revoke.

import { invoke } from "@tauri-apps/api/core";

/** Default LAN-bridge port. The QR carries it, so the phone uses whatever we bound. */
export const LAN_BRIDGE_PORT = 8788;

export interface BridgeStatus {
  running: boolean;
  port: number;
  paired: boolean;
}

/** The pairing payload the phone scans (Rust `PairingInfo`). `key` is base64 of 32 bytes. */
export interface PairingInfo {
  url: string;
  host: string;
  port: number;
  key: string;
}

/** Enable remote control: ensure a key, bind the LAN, return the QR payload. Idempotent. */
export const enableBridge = (port = LAN_BRIDGE_PORT): Promise<PairingInfo> =>
  invoke<PairingInfo>("lan_bridge_enable", { port });

/** Stop listening (keeps the pairing — a re-enable reuses the same key). */
export const stopBridge = (): Promise<void> => invoke<void>("lan_bridge_stop");

/** Revoke pairing entirely (stop + wipe the key). A paired phone is cut off. */
export const unpairBridge = (): Promise<void> => invoke<void>("lan_bridge_unpair");

export const bridgeStatus = (): Promise<BridgeStatus> => invoke<BridgeStatus>("lan_bridge_status");

/** The exact string the QR encodes / the phone pastes — the PairingInfo as JSON. */
export const pairingPayload = (info: PairingInfo): string => JSON.stringify(info);

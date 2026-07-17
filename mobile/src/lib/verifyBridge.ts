// Interop harness (run in Node via `npm run verify:bridge`) — proves this app's actual sealed client
// (lanClient.ts) speaks the L1c wire protocol correctly against a live Loom bridge, without needing
// an Android emulator. The client is pure JS, so the same file that runs on the phone runs here.
//
// Env: LOOM_BRIDGE_URL (default ws://127.0.0.1:8899), LOOM_KEY_B64 (the pairing key, base64).

import { LanBridgeClient, b64ToBytes } from "./lanClient";
import type { PaneInfo } from "../protocol";

async function main() {
  const url = process.env.LOOM_BRIDGE_URL ?? "ws://127.0.0.1:8899";
  const keyB64 = process.env.LOOM_KEY_B64;
  if (!keyB64) throw new Error("set LOOM_KEY_B64 to the bridge pairing key (base64)");
  const psk = b64ToBytes(keyB64);

  // 1) correct key → sealed list round-trips
  const client = new LanBridgeClient(url, psk);
  await client.connect();
  console.log("handshake: sealed channel established");
  const res = await client.call({ op: "list" });
  if (!res.ok) throw new Error("list failed: " + res.error);
  const panes = res.data as PaneInfo[];
  console.log("sealed list ok — panes:", panes.map((p) => p.name).join(", "));
  console.log("  enriched fields present:", panes.some((p) => "status" in p || "attention" in p) ? "yes (P0c)" : "none set");
  client.close();

  // 2) wrong key → the server drops us (every frame fails the AEAD tag)
  const wrong = new LanBridgeClient(url, new Uint8Array(32));
  try {
    await wrong.connect();
    await wrong.call({ op: "list" });
    throw new Error("WRONG KEY WAS ACCEPTED — auth is broken");
  } catch (e) {
    if (e instanceof Error && e.message.includes("WRONG KEY WAS ACCEPTED")) throw e;
    console.log("wrong key rejected:", (e as Error).message);
  } finally {
    wrong.close();
  }

  console.log("\nINTEROP OK — the RN client speaks L1c correctly.");
  process.exit(0);
}

main().catch((e) => {
  console.error("INTEROP FAILED:", e.message ?? e);
  process.exit(1);
});

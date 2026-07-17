# Loom mobile (Android, local-first)

The phone half of Plan 02's local-first path. Drives a Loom fleet over the **sealed LAN bridge**
(`src-tauri/src/lanbridge.rs` + `lansec.rs`) — same Wi-Fi, no VPS. Self-contained Expo/React Native
project, co-located in the repo like `loom-voce/`; **not** a root workspace member (its own lockfile,
excluded from root CI).

## What works

- **Sealed transport** (`src/lib/lanClient.ts`) — the L1c wire protocol (salt handshake → HKDF-SHA256
  session key → ChaCha20-Poly1305 counter-nonce frames), pure JS via `@noble`. Verified interoperating
  with the live Rust bridge (`npm run verify:bridge`).
- **Pairing** — scan the laptop's QR or paste the code; the 32-byte key is stored in
  `expo-secure-store` (Android Keystore), never in the clear.
- **Fleet** — polls `list` (the one unprompted op), shows each pane's P0c state.
- **Pane detail** — `read` the tail, `send` input; both are `approve` ops, so the laptop parks a
  Clearance and the app shows "waiting for approval on the laptop" until it's answered there.

## Run it

```bash
cd mobile
npm install
npx expo start        # then press `a`, or scan the QR in Expo Go on your Android
```

On the laptop, enable the bridge and show the pairing QR (Settings → Remote — L2 UI pending; until
then use the `$LOOM_LAN_BRIDGE_PORT` / `$LOOM_LAN_BRIDGE_KEY` dev seam and paste the JSON code).

## Verify the crypto against a live bridge (no emulator needed)

```bash
# with a Loom bridge running (LOOM_LAN_BRIDGE_PORT + LOOM_LAN_BRIDGE_KEY set):
LOOM_KEY_B64=<the base64 key> LOOM_BRIDGE_URL=ws://127.0.0.1:8899 npm run verify:bridge
```

The same `lanClient.ts` that runs on the phone runs here in Node — so a green `verify:bridge` proves
the app's crypto speaks the protocol correctly.

## Not built yet

- The **Clearance / attention inbox** (push comes later; for now Clearances are answered on the laptop).
- **Multi-Host** (ADR-0012 rule 7) — one pairing today.
- The laptop-side **Settings → Remote** UI (pair button + QR render).
- ⚠️ `lansec.rs`'s crypto still wants an independent review before carrying real secrets (no forward
  secrecy — see the module docs).

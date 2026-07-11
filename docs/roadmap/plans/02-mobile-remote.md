# Plan 02 — Mobile remote control (fully remote via VPS relay)

**Status:** planning · **Effort:** weeks (multi-phase flagship) · **Rust:** yes (new bridge)
**ADR:** **[ADR-0012 — Remote fleet control over a dial-out VPS relay](../../adr/0012-remote-fleet-control-dial-out-vps-relay.md)** (drafted; the decisions below are resolved there). This is the first thing to break ADR-0007's "local unix socket only, no network exposure" boundary.
**Decisions locked:** a **native app** (React Native, Android first), **fully remote** via the user's own VPS as a **blind end-to-end relay** — reachable from anywhere, not just the LAN.

## Goal

Drive and observe the fleet from a phone, from anywhere: list panes, read/send to a pane, see and
receive **push notifications for `attention` signals** ("Faye needs you"), broadcast a prompt.

## Architecture — dial-out, blind, end-to-end (no inbound port on the laptop)

```
[React Native app] ──WSS(E2E)──> [Go relay on VPS] <──WSS dial-OUT(E2E)── [Loom bridge] ──unix sock──> control bus
   Device, anywhere               rendezvous + pair + push                 in the Loom process         (ADR-0007)
        └────────────── end-to-end sealed; the relay routes ciphertext, never sees plaintext ─────────────┘
```

- The **Loom bridge dials out** to the VPS, so the laptop needs **no open ports / firewall changes /
  NAT punching**. The relay just pairs a phone (a **Device**) session with its laptop session.
- **End-to-end sealed:** the relay is a *blind forwarder* — it sees ciphertext + routing metadata,
  never plaintext. Chosen because `read` ships raw scrollback (secrets/tokens/`ssh`) and `send` types
  into live shells; "your own VPS" is still a box on the internet that can be popped. (ADR-0012 rule 2.)
- The VPS already hosts the site (Plan 03) — **reuse its nginx + Let's Encrypt TLS** for the WSS
  outer layer, add a `relay.` subdomain. (E2E is a second, app-layer seal *inside* that TLS.)

## Components

### 1. Loom bridge (Rust, in-process)
- Exposes the control-bus verbs the CLI/MCP already speak: `list`, `send`, `read`, `focus`,
  `attention`, `status`, `broadcast`.
- **Reuses** `src-tauri/src/control_sock.rs` (socket client) and the TS routing in
  `src/lib/paneControl.ts` — the bridge is a *network front-end onto the same bus*, not new product
  logic. It terminates the E2E hop, decrypts, and injects the same `ControlRequest` the socket would —
  **tagged `origin: device:<name>`** so dispatch can branch guardrail enforcement (see §3). Routing +
  policy stay in TS per the no-product-logic-in-Rust rule; the Rust bridge is transport.
- Config/toggle in Settings ("Enable remote control"), **off by default**; disabled until a Device is paired.

### 2. VPS relay (small **Go** service on the user's VPS)
- Rendezvous: authenticate both ends, pair phone↔laptop sessions, forward **sealed** frames. Blind
  (never decrypts). A per-session **frame-rate** cap as the DoS floor — content-agnostic (ciphertext only).
- **Go** chosen: fastest path to a static-binary WS proxy, trivial cross-compile, systemd unit behind
  the existing nginx/certbot. Language barely matters *because* the relay is blind (~a few hundred lines).

### 3. Auth & security (load-bearing — the ADR's core)
- **Device pairing**: laptop shows a QR/code; phone scans once → establishes the **end-to-end key**
  *and* mints a **long-lived, revocable Device token** bound to it. Settings lists Devices with a
  **Revoke** (a lost phone must be cuttable off; revoking kills the token *and* the key).
- **Origin-aware guardrails (the crux).** The existing gate / destructive-broadcast / spawn guards all
  enforce via a synchronous `window.confirm` on the laptop webview — which would *hang the unattended
  UI* for a remote command. So a **remote-origin** command **never fires a desktop modal**; instead the
  guardrail converts to a **mobile approval round-trip** (push → Approve/Deny on the phone,
  **default-deny** on timeout/unreachable). This is how the input gate (`stores/inputHolds.ts`,
  `loom gate`) is genuinely reused — the human-in-the-loop moves to the device that's present. It also
  settles the "per-session unlock?" question: remote `send`/`broadcast`/`spawn` are **gated by
  construction**.
- **Audit records origin.** `AuditEntry` (`stores/audit.ts`) gains an `origin` field so a phone-driven
  `broadcast` is attributable and distinguishable from a local one — mandatory for a feature whose risk
  is *commands from the internet in live shells*.
- **Semantic rate-limiting** of `send`/`broadcast`/`spawn` lives in TS `paneControl` (post-decrypt),
  not the blind relay.

### 4. Native app (React Native, Android first)
- **React Native**: shared TS types (`ipc/protocol.ts` `ControlRequest`/`Response`), one language across
  desktop + mobile, mature FCM/APNs push libs. **Android first** (FCM, sideload/Play — no App Store
  review latency while iterating); **iOS later** behind APNs.
- Screens: fleet list (roles + status, mirrors `FleetPanel`), pane detail (read tail + send box),
  broadcast, attention inbox, **approval inbox** (the Approve/Deny prompts from §3), paired-device settings.
- **Push notifications** on `attention` signals — the payoff feature. Payloads are **metadata-only**
  ("a pane needs you"); the relay routes the push and stays blind, so the app fetches specifics over the
  E2E channel on open.

## Phasing (de-risk in order)

- [ ] **P1 — LAN bridge:** bridge serves the verbs over a local WebSocket; prove them from a browser /
      script on the same Wi-Fi. No relay, no auth, no E2E. Validates the bus-over-network surface only —
      **not shippable.**
- [ ] **P2 — VPS relay + pairing + E2E:** dial-out to the VPS, QR pairing, end-to-end sealing, origin
      tagging + audit, the approval round-trip. First shippable, safe state.
- [ ] **P3 — React Native app** (Android) over P2.
- [ ] **P4 — Push:** `attention` → metadata-only push to the paired Device.

## ADR

Written first, as required: **[ADR-0012](../../adr/0012-remote-fleet-control-dial-out-vps-relay.md)** —
covers why dial-out (no inbound port), the blind-relay E2E trust boundary, the pairing/token/revocation
model, the origin-aware reuse of the ADR-0007 bus + input-gate + audit machinery, and what stays off by
default. Stress-tested against ADR-0007 and the safety features via `grill-with-docs` (2026-07-11).

## Grounding

- `src-tauri/src/control_sock.rs`, `control.rs` (ADR-0007 relay), `cli.rs`, `mcp.rs`.
- `src/lib/paneControl.ts` (bus routing + the three `window.confirm` guardrails to make origin-aware),
  `src/components/FleetPanel.tsx` (the UI to mirror on mobile).
- `src/stores/inputHolds.ts`, `src/stores/audit.ts` (gate + audit to reuse; audit gains `origin`).
- Attention/status signals: `loom attention` / `loom status` (see `loom-commands` skill).

## Open questions — resolved (2026-07-11, in ADR-0012)

- [x] React Native vs Flutter → **React Native** (shared TS types, one language, FCM/APNs libs).
- [x] Relay implementation language + deploy → **Go** WS proxy; static binary + systemd behind the Plan
      03 nginx/certbot, `relay.` vhost. (Blind relay ⇒ language is low-stakes.)
- [x] End-to-end encryption vs. TLS-to-relay only → **end-to-end**; the relay is a blind forwarder.
      `read` ships secrets, so a compromised VPS must not be able to read scrollback or forge sends.
- [x] iOS + Android both, or start with one? → **Android first**, iOS later (APNs).
- [x] Does remote `send`/`broadcast` require an explicit per-session "unlock"? → **Gated by
      construction**: a remote command that trips a guardrail is a push-approval on the phone
      (default-deny), never a desktop modal. No separate unlock needed.

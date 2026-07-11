# Remote fleet control over a dial-out VPS relay

**Status:** Proposed (2026-07-11); **draft.** **Extends [ADR-0007](0007-inter-pane-control-bus.md)** — it deliberately breaks 0007's load-bearing invariant ("a unix-domain socket, same-user-only, *no network exposure*") by exposing the control bus over the internet. It does **not** touch ADR-0001's opacity rule (Loom still never parses pane *output*; `read` ships bytes on explicit request, unchanged) or the no-product-logic-in-Rust split. This ADR must be accepted before the first line of bridge code (Plan 02 P1).

## Context

The control bus (ADR-0007) lets a process inside a Pane drive other Panes — `list`, `send`, `read`, `focus`, `attention`, `status`, `broadcast`. Its entire security model is one sentence: **the trust boundary is the OS user.** The socket lives at `$XDG_RUNTIME_DIR/loom.sock` (mode 0600), so only the user who launched Loom can connect, which is "exactly the set of principals who can already drive the user's terminals by other means." Every Pane holds ambient authority over every other Pane *because* that set is already the local user and no one else.

Plan 02 wants to drive and observe the fleet **from a phone, from anywhere** — list Panes, read/send to a Pane, receive a push when an agent raises `attention`, broadcast a prompt. That introduces a principal ADR-0007 explicitly excluded: **a device on the internet, reached through a third-party VPS.** "Same-user-only, no network exposure" is precisely the property we are giving up. This is not a tweak to 0007; it is a new trust boundary, which is why it needs its own ADR.

Two facts about the existing code shaped every decision below, and a naïve "just put the bus on a WebSocket" would violate both:

- **The safety guardrails are synchronous desktop modals.** The input gate (`stores/inputHolds.ts`, `loom gate`), the destructive-broadcast guard (`settings.confirmDestructiveBroadcast`), and the spawn guard (`settings.confirmExternalSpawn`) all enforce via **`window.confirm(...)`** in `paneControl.ts` — a blocking modal on the laptop's WebKitGTK webview. For an *unattended* laptop (the whole point of remote), such a modal (a) has no one to click it and (b) **blocks the webview thread**, freezing the entire UI and every Pane's rendering until someone walks over. The gate's *policy* is exactly what we want remotely; its *mechanism* cannot be reused as-is.
- **The bus is origin-blind by design.** ADR-0007: "Rust attaches no caller identity (it's a pure relay)." `audit.ts` records `op`/`target`/`ok`/`detail` and no origin. That is fine when every caller is the local user; it is unacceptable for a feature whose defining risk is *commands from the internet running in live shells* — the operator must be able to tell a local, pane-driven `broadcast` from one a phone sent while they were at lunch, both live and after the fact.

## Decision

Add a **dial-out network front-end onto the existing bus** — the **Bridge** — that reaches the phone through a **blind Relay** on the user's VPS. The Bridge is transport (it terminates the network hop, decrypts, and injects the same `ControlRequest` the local socket would); all routing and all policy stay in TS `paneControl`, per the golden split. It is **off by default** and gated by an explicit Settings toggle.

```
[React Native app] ──WSS(E2E)──> [Go Relay on VPS] <──WSS dial-OUT(E2E)── [Loom Bridge] ──unix sock──> control bus
   Device, anywhere              rendezvous + pair + fan push               in the Loom process        (ADR-0007)
        └──────────── end-to-end sealed; the Relay routes ciphertext, never sees plaintext ───────────┘
```

Six rules bound this, mirroring the way ADR-0011 bounded its risk:

### 1. Dial-out only — the laptop never listens

The Bridge **dials out** to the Relay over WSS; the laptop opens **no inbound port**, needs no firewall/NAT/UPnP changes. The Relay is a rendezvous that pairs a Device session with its laptop session and forwards frames between them. This keeps the attack surface on the laptop at *zero listening sockets* — the only way in is a frame the Bridge itself pulled down over a connection it initiated.

### 2. The Relay is a blind forwarder — end-to-end sealed

Because `read` ships raw scrollback (secrets, tokens, live `ssh` sessions) and `send` types into live shells, **the Relay must never see plaintext.** Device and Bridge establish a shared key **at pairing time**; every bus frame is sealed end-to-end, and the Relay sees only ciphertext plus the minimum routing metadata (which Device ↔ which laptop session). A compromised VPS — and "your own VPS" is still a box on the internet that can be popped — **cannot read scrollback or forge a `send`.** Consequences: the Relay cannot inspect content (so semantic rate-limiting can't live there, see rule 5), and **push payloads are metadata-only** (rule 6).

### 3. Remote is a distinct **Origin**; guardrails re-home to the Device, never a desktop modal

Every bus request injected by the Bridge is tagged **`origin: device:<name>`** (vs. the implicit `origin: local` for socket/pane callers). `paneControl.dispatch` branches on origin:

- A **local**-origin command hits a guardrail → the existing `window.confirm` path, unchanged.
- A **remote**-origin command **never fires a desktop modal** (it would hang the unattended UI). Instead the guardrail converts to a **mobile approval round-trip**: the request parks, the Bridge pushes an approve/deny prompt to the paired Device, and the command proceeds only on an explicit **Approve**. It **default-denies** on timeout (e.g. 60 s) or if the Device is unreachable.

This re-homes the human-in-the-loop to the device that is actually present, which is the *only* way "reuse the input gate/audit" is true rather than aspirational. It also answers Plan 02's per-session-unlock question: **remote `send`/`broadcast`/`spawn` are gated by construction** — the gate on a sensitive Pane, the destructive-broadcast guard, and the spawn guard all funnel a remote command into this same approve/deny prompt.

### 4. Audit records Origin — mandatory, not optional

`AuditEntry` gains an `origin` field (`local` | `device:<name>`); `recordAudit` is called for remote-injected commands on the same timeline as local ones. A remote `broadcast` is visible, attributable, and distinguishable from a local one — both live in the Fleet panel and in the after-the-fact record. Without this the feature is unauditable, so it is a hard requirement of accepting this ADR, not a nice-to-have.

### 5. Rate-limiting splits by layer

Remote `send`/`broadcast` run commands in live shells, so they are rate-limited at **two** layers, matching where each layer can see:

- **Relay (coarse, blind):** a per-session **frame-rate** cap as a DoS floor. Content-agnostic (it only has ciphertext) — it bounds flooding, nothing semantic.
- **Bridge/TS `paneControl` (semantic):** limits on `send`/`broadcast`/`spawn` specifically, applied after decryption, in TS — keeping the policy in TS per no-product-logic-in-Rust. This is where "no more than N sends/sec from a Device" and the approval-round-trip live.

### 6. Pairing, device tokens, and revocation

Pairing is an explicit, local, in-person act: the laptop shows a **QR/code**; the phone scans it once. That exchange both (a) establishes the **end-to-end key** (rule 2) and (b) mints a **long-lived Device token** bound to that key. Consequences:

- **Revocable:** Settings lists paired Devices with a **Revoke** (a lost phone must be cuttable off; revoking invalidates the token *and* the E2E key so a stolen token is inert).
- **Off by default:** remote control is disabled until the user both enables it and completes a pairing.
- **Push is metadata-only:** an `attention` raise fans to the Device's push token as *"a Pane needs you"* with no plaintext (the Relay routes it and must stay blind); the app fetches specifics over the E2E channel on open.

## Why not the obvious alternatives

- **Put the bus on a plain WebSocket / LAN-only (Plan 02 P1's throwaway step).** Fine as a de-risking spike on trusted Wi-Fi, but not shippable: no auth, and it inherits ADR-0007's "network exposure = same-user-authority-to-anyone-on-the-LAN" problem. P1 is explicitly a validation step, not the product.
- **Inbound port + port-forward / Tailscale.** Requires the user to open a port or run a mesh VPN; "from anywhere with zero laptop network config" was the goal, and dial-out delivers it with a smaller laptop attack surface (rule 1).
- **TLS-to-relay-only (no E2E).** Simpler, and lets the Relay rate-limit on content — but the VPS then sees every scrollback tail and can forge sends. That is *weaker* than the same-user boundary ADR-0007 started from, for a feature that ships secrets over the wire. Rejected (rule 2).
- **Let remote commands trigger the existing desktop confirm.** Hangs the webview thread on an unattended laptop (see Context). The whole reason for the origin-branch in rule 3.
- **A full per-Pane capability system** (ADR-0007's "tracked, not built" future). Still deferred; the Origin tag + remote approval round-trip is the minimum that makes remote safe without it.

## Consequences

- **ADR-0007's one-sentence trust model no longer holds globally.** It remains true for local-origin bus traffic; remote-origin traffic is governed by *this* ADR (pairing, E2E, per-command approval, audited origin) instead of "the OS user." Update the cross-reference in 0007 when this is accepted.
- **`paneControl.dispatch` becomes origin-aware.** The request type gains an `origin`; the three guardrail helpers (`confirmExternalSpawn`, `confirmDestructiveBroadcast`, `confirmHeldPaneInput`) grow a remote branch that pushes an approval instead of calling `window.confirm`. This is the one place the golden split's "routing in TS" now also carries *policy* differences by origin — deliberately, because policy is product logic.
- **`AuditEntry`/`recordAudit` extend with `origin`** (rule 4). The Fleet panel's audit view should surface it.
- **New moving parts to operate:** a Go WS-proxy Relay (systemd unit behind the existing nginx/certbot on the Plan 03 VPS, a `relay.` vhost), a React Native app (Android first; iOS later behind APNs), and key/token storage on both ends. The Relay is ~a few hundred lines *because* it is blind — it pairs sessions and forwards ciphertext, nothing more.
- **Opacity is intact.** `read` still ships bytes only on explicit request and Loom never parses them; E2E just means those bytes are sealed to the VPS. ADR-0001 is untouched.
- **Linux-first still holds on the laptop** (the Bridge dials out from the same process that owns the unix socket); the Relay and app are new, separate deployables.

## Phasing (unchanged from Plan 02, de-risk in order)

- **P1 — LAN bridge:** verbs over a local WebSocket, proven from a script on the same Wi-Fi. No Relay, no auth, no E2E. Validates the bus-over-network surface only; **not shippable.**
- **P2 — Relay + pairing + E2E:** dial-out to the VPS, QR pairing, end-to-end sealing, origin tagging + audit, the approval round-trip. This is the first shippable, safe state.
- **P3 — React Native app** over P2 (Android first).
- **P4 — Push:** `attention` → metadata-only push to the paired Device.

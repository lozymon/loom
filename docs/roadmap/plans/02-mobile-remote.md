# Plan 02 — Mobile remote control (fully remote via VPS relay)

**Status:** planning · **Rust:** yes (new bridge)
**ADR:** **[ADR-0012 — Remote fleet control over a dial-out VPS relay](../../adr/0012-remote-fleet-control-dial-out-vps-relay.md)** (drafted; the decisions below are resolved there). This is the first thing to break ADR-0007's "local unix socket only, no network exposure" boundary.
**Decisions locked:** a **native app** (React Native, Android first), **fully remote** via the user's own VPS as a **blind end-to-end relay** — reachable from anywhere, not just the LAN.

## Effort — two tiers, deliberately separable

- **P0a+P0b+P0c — ~1 week, ships on its own.** All three are *local* fixes with local value: a durable
  audit trail, a webview that no longer freezes when an agent asks permission, and a `loom list` that
  reports status. None needs a phone, a VPS, or even ADR-0012 to be accepted.
- **P1–P4 — the flagship: months, not "weeks."** Rust bridge + Noise + pairing UI, a Go relay with
  persisted state and deploy, a React Native app (incl. a JS Noise stack, Keystore wrapping, a QR
  scanner and an **ANSI renderer** — there is no xterm.js on RN), then FCM push.

The split is load-bearing, not bookkeeping: a single "weeks" estimate over a monolithic flagship means
the first thing sacrificed when it overruns is the pairing/E2E/policy work — i.e. the parts that make it
safe. Tiering it means value lands in week one and the security work is never what stands between you
and a shippable result.

## Goal

**"Your agents ask, your phone answers."** Observe the fleet from anywhere and — the payoff —
**answer the Agent that is blocked on you**, by push ("Faye needs you"), instead of the work stalling
until you walk back to the laptop.

Precisely: the payoff is **Approvals** (ADR-0008 — an Agent blocked on its own stdin, which waits
*indefinitely*), **not Clearances** (an Agent blocked on a bus reply, which dies with its caller in ~2
minutes — Claude Code's Bash tool times out at 120 s by default). See ADR-0012 rule 3.5.

Driving (`send`/`read`/`broadcast` from the phone) is the **second-class half**: it carries essentially
the entire risk budget of this plan, and its remote approve/deny tap is a Confirmation, not an
authorization boundary (ADR-0012 rule 3.3 — actor and decider are the same human on the same phone).
It is worth having, but the plan is **not** justified by it and it must not be built first. See
ADR-0012 rule 3.2–3.4 for the split.

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
- Exposes **only the verbs rule 3's policy table admits** — `list` (allow) and `send`/`read` (approve).
  Not `focus`, `broadcast`, `spawn`, `status`, `attention`, `gate.*`: the Bridge is a front-end onto the
  bus, **not** onto all of it.
- **Reuses** `src-tauri/src/control_sock.rs` (socket client) and the TS routing in
  `src/lib/paneControl.ts` — the bridge is a *network front-end onto the same bus*, not new product
  logic. It terminates the E2E hop, decrypts, and injects the same `ControlRequest` the socket would —
  **tagged `origin: device:<name>`** so dispatch can apply the policy table (see §3). Routing +
  policy stay in TS per the no-product-logic-in-Rust rule; the Rust bridge is transport.
- Config/toggle in Settings ("Enable remote control"), **off by default**; disabled until a Device is paired.

### 2. VPS relay (small **Go** service on the user's VPS)
- Rendezvous: authenticate both ends, pair phone↔laptop sessions, forward **sealed** frames. Blind
  (never decrypts). A per-session **frame-rate** cap as the DoS floor — content-agnostic (ciphertext only).
- **Blind ≠ stateless** (ADR-0012 rule 6.4): it persists `pending[pid]` + `pairing[pid]` (token
  hashes, push token) — routing metadata only, none of which decrypts a frame. **Must survive
  restart**, or `systemctl restart` silently unpairs every Device.
- **Enrollment key** (systemd `EnvironmentFile=`) gates `pid` registration — otherwise the `relay.`
  subdomain is an open rendezvous for anyone who finds it. Not a data boundary (E2E is that); it
  keeps your VPS from being a free relay for strangers.
- Plan 03 already reserves the DNS, writes the `relay.` nginx block (WS upgrade → `127.0.0.1:8787`)
  and puts both names on one cert — **Plan 02 does zero nginx/cert work**. It binds **loopback only**;
  no new inbound port. But Plan 03's deploy key is `rrsync`-locked to the webroot, so shipping the
  relay binary needs its own path (manual `scp` + `systemctl restart` is fine — it barely churns).
- **Go** chosen: fastest path to a static-binary WS proxy, trivial cross-compile, systemd unit behind
  the existing nginx/certbot. Language barely matters *because* the relay is blind (~a few hundred lines).

### 3. Auth & security (load-bearing — the ADR's core)
- **Device pairing — the QR is the only trust anchor** (ADR-0012 rule 6, fully specified there).
  The QR carries the laptop's **X25519 public key**, so scanning it in person is an out-of-band
  channel the VPS is not part of: afterwards the phone knows *which* Loom is its Loom without ever
  trusting the Relay. First pairing runs **`Noise_XKpsk3`** (PSK derived from the QR secret, so
  holding the — non-secret — public key isn't enough to pair); reconnects run **`Noise_KK`**.
  A misrouting Relay hands the wrong endpoint an undecryptable frame; it cannot pair itself as a
  Device, because the Relay only ever sees `HKDF(s,"relay-ticket")`, never the PSK.
  Settings lists Devices with a **Revoke** that deletes the stored `P_D` — enforced **at the bridge**
  (the next `KK` fails), so revocation doesn't depend on the Relay being honest or reachable.
- **One phone, N Hosts** (ADR-0012 rule 7): each Pairing is independent — own `pid`, own Host key,
  **own Device keypair**, optionally own Relay — for **revocation independence** (revoking at work
  leaves home untouched). The app is **Host-scoped from v1**. Terms are load-bearing and defined in
  CONTEXT.md: a **Host** is one running Loom; a **Device** is a paired principal *as one Host knows it*
  (**not** a phone — one phone is N Devices across N Hosts); a **Pairing** is the relationship.
- **Deny-by-default per-op policy (the crux)** — ADR-0012 rule 3. Do **not** bound remote risk with the
  existing guardrails: only `spawn`/destructive-`broadcast`/gated-`send` carry one, and everything else
  is unguarded *because ADR-0007 made guarding pointless* — a premise this plan repeals. Inheriting that
  set would ship two holes: remote `read` returns 2000 lines of scrollback ungated (`paneControl.ts:130`
  — the very secrets E2E exists to protect), and `gate.set{on:false}`+`send` walks the gate in two calls
  (`:176`). Instead every op carries an explicit disposition and **unlisted fails closed**:
  `allow` = `list` alone; `approve` = `send`/`read`; `deny` = **everything else** — including `status`
  and `attention`, which *sound* like reads but are setters. One reader, two writers, nothing else.
  An op earns a disposition by having a **use case *and* an app surface** — so remote `spawn` and the
  gate bypass are **absent, not gated**.
- **Clearances, not modals** (rule 3.4). The three `window.confirm` guards are synchronous: an agent
  tripping one on an unattended laptop freezes the webview and every Pane's rendering. They become
  parked, non-blocking **Clearances** — in-app panel + optional Device push, default-deny on timeout —
  for **both** Origins. Note the asymmetry this exposes (rule 3.2–3.3): for an *agent's* command decided
  by *you*, a Clearance is a real authorization boundary; for a command *you* sent from *your* phone,
  actor and decider are the same human, so it is only a **Confirmation** — typo protection, not a
  control. Flow B is the feature; Flow A rides along.
- **Audit records origin.** `AuditEntry` (`stores/audit.ts`) gains an `origin` field so a phone-driven
  `send` is attributable and distinguishable from a local one — mandatory for a feature whose risk
  is *commands from the internet in live shells*. See P0a: the store is currently ephemeral.
- **Semantic rate-limiting** of `send`/`read` — the only reachable writers — lives in TS `paneControl` (post-decrypt),
  not the blind relay.

### 4. Native app (React Native, Android first)
- **React Native**: shared TS types (`ipc/protocol.ts` `ControlRequest`/`Response`), one language across
  desktop + mobile, mature FCM/APNs push libs. **Android first** (FCM, sideload/Play — no App Store
  review latency while iterating); **iOS later** behind APNs.
- Screens: **Host picker** (the paired-Host list — label + key fingerprint, since identity is the Host key and
  two Hosts will both be labelled "laptop"), fleet list (roles + status, mirrors `FleetPanel`), pane detail (read tail +
  send box), attention inbox, **Clearance inbox** (§3 — each stating *which* Loom is asking), paired-device
  settings.
- **No broadcast screen** (ADR-0012 rule 3): the human broadcast bar was removed 2026-06-25 as unused,
  and its single-Workspace scope is the structural reason it never served cross-project work — a phone
  would rebuild that flaw on a worse keyboard. Remote `broadcast` is `deny`; `loom broadcast` is
  untouched. **No spawn/gate/role screens** either — hence those ops are `deny`, so remote RCE and the
  `gate.set{on:false}`→`send` bypass are *absent*, not gated.
- The **Clearance inbox** and the **attention inbox** are separate lists on purpose: a Clearance is Loom
  holding a command pending your go/no-go; an Attention/Approval is an Agent reporting it is blocked on
  you (ADR-0008). Same screen shape, different entities — see CONTEXT.md.
- Every screen is **scoped to the selected Pairing** (ADR-0012 rule 7). Keys are **Keystore-wrapped**
  (rule 6.1 — a non-extractable key can't feed a JS Noise lib).
- **Swipe between Panes** on the Pane-detail screen, with a visible Pane strip (name chips + state dots)
  above it — a swipe with no affordance is undiscoverable, and the strip doubles as fleet state. Three
  decisions this forces, all cheap now and expensive later:
  - **Scope: within the Workspace, in layout-tree leaf order** — never across Workspaces (matches the
    two-level hierarchy and Broadcast's rule). "Next" on the phone is the Pane next to it on the laptop,
    so spatial memory transfers. **Dead Panes included**: they keep their tile on the desktop precisely
    because the exit code is post-mortem evidence, and that's most wanted when an agent died while you
    were out.
  - **The ANSI renderer must wrap — no horizontal pan.** `read` returns raw lines routinely wider than a
    phone; if the terminal pans horizontally the swipe gesture is ambiguous. Decide before the renderer
    is written, not after.
  - **No neighbour prefetch.** Each prefetch is a real `read`: more scrollback over the wire, more secrets
    pulled you never looked at, more pressure on rule 5's limiter. Fetch on settle.
- Swipe is also what makes the **Read Window** (rule 3) load-bearing rather than optional — a gesture whose
  value is fluid movement can't survive a Confirmation per step.
- **Push notifications** on `attention` signals — the payoff feature. Payloads are **metadata-only**
  ("a pane needs you") + `pid` so the app knows which Loom raised it and can deep-link; the relay routes
  the push and stays blind, so the app fetches specifics over the E2E channel on open.

## Phasing (de-risk in order)

**The relay's *location* is not a phase.** Build the dial-out + blind-relay + E2E architecture from the
start; run the Go relay on localhost/LAN while iterating and `scp` it to the VPS when it works — going
live is a deploy step, not a redesign. A LAN-only *product* was considered and rejected: it saves only
the cheap piece (the blind relay is ~a few hundred lines) while still needing all of P2's pairing/E2E/
origin/audit work to be safe, **and** it bakes in an inbound laptop listener that ADR-0012 rule 1
rejects. P1 below is the UX spike that a LAN-only app would otherwise be an expensive way to buy.

- [ ] **P0a — audit persistence:** `stores/audit.ts` is a 500-entry in-memory ring, cleared on restart.
      ADR-0012 rule 4 makes origin-tagged audit a hard requirement and names an "after-the-fact record"
      that doesn't exist. Persist audit rows (third table in ADR-0009's `sessions.db`). **Prerequisite,
      not follow-up** — it's small, and it's currently invisible in the checklist.
- [ ] **P0b — Clearances: de-block the guardrails** (ADR-0012 rule 3.4). The three `window.confirm`
      helpers in `paneControl.ts` are synchronous: an agent tripping one on an unattended laptop
      freezes the webview and every Pane's rendering until someone walks over. Replace with parked,
      non-blocking Clearances + an in-app panel. **Ships value with no phone, no relay, no ADR-0012** —
      a local defect fix, and that is now its main justification (rule 3.5: Clearances die with their
      caller in ~2 min, so they are rarely answerable from a phone). Distinct from ADR-0008's Approval
      (see CONTEXT.md) — do not merge the two inboxes. Two things to settle before coding:
      **(a) lifetime** — no wall clock; a Clearance lives while its caller waits and is *withdrawn* (not
      denied) when the caller vanishes; **(b) the abort signal** — `control.rs` must report
      caller-disconnect *before* the frontend can execute, or Approve on a dead Clearance spawns a pane
      nobody awaits.
- [ ] **P0c — extend `list`'s payload.** It returns `{name, workspace, focused, live, role, gated}` —
      **no `status`, no `attention`** (`paneControl.ts`). `FleetPanel` reads those from the TS store
      in-process, so nothing noticed; the app is the first wire consumer. **The fleet screen — the
      payoff half — has no data source until this lands.** Add `status`, `attention`, ADR-0008 Session
      state. Opacity-safe (pushed signals, never parsed output) and improves `loom list` locally today.
- [ ] **P1 — LAN bridge (spike):** bridge serves the verbs over a local WebSocket; prove them from a
      browser / script on the same Wi-Fi. No relay, no auth, no E2E. **Not shippable** — but point a
      *phone browser* at it to answer "does driving a fleet from a phone feel good?" for a day's work
      instead of weeks of React Native.
- [ ] **P2 — Relay + pairing + E2E:** dial-out, QR pairing (rule 6: XKpsk3 → KK, HKDF-split ticket/psk),
      persisted relay state + enrollment key, bridge ping/pong under nginx's 3600s read timeout,
      origin tagging + audit, Clearances over the wire. First shippable, safe state.
- [ ] **P3 — React Native app** (Android) over P2 — Host-scoped from v1 (rule 7).
- [ ] **P4 — Push:** `attention` → metadata-only push (+ `pid`) to the paired Device.

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

## Open questions — resolved (2026-07-15, in ADR-0012 rules 6–7)

- [x] How does the app know it's talking to *my* Loom and not someone else's? → **The QR carries the
      laptop's public key**; scanning it in person is an out-of-band channel the VPS isn't part of.
      The Relay's routing table is untrusted input — misrouting yields an undecryptable frame, not a
      compromise. Trust comes from the pairing, never from the VPS.
- [x] Does the VPS store anything, or is it purely transparent? → **Both, and they're different
      questions.** Trust-wise transparent (it holds nothing that reads your data or impersonates your
      Loom); state-wise **not stateless** (pairing IDs, token hashes, push tokens — routing metadata,
      persisted across restarts).
- [x] One phone, multiple Looms? → **Yes, designed in** (rule 7): independent pairings, own Device
      keypair each, Host picker in the app, `pid` on every push and Clearance.
- [x] Key storage → laptop: 0600 file (guarded by ADR-0007's OS-user boundary, which already gates the
      control socket); phone: Android Keystore (a lost phone is an explicit threat).

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

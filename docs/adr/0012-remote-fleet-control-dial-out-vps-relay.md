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

Seven rules bound this, mirroring the way ADR-0011 bounded its risk:

### 1. Dial-out only — the laptop never listens

The Bridge **dials out** to the Relay over WSS; the laptop opens **no inbound port**, needs no firewall/NAT/UPnP changes. The Relay is a rendezvous that joins a Device's connection to its Host's and forwards frames between them. This keeps the attack surface on the laptop at *zero listening sockets* — the only way in is a frame the Bridge itself pulled down over a connection it initiated.

### 2. The Relay is a blind forwarder — end-to-end sealed

Because `read` ships raw scrollback (secrets, tokens, live `ssh` sessions) and `send` types into live shells, **the Relay must never see plaintext.** Device and Bridge establish a shared key **at pairing time**; every bus frame is sealed end-to-end, and the Relay sees only ciphertext plus the minimum routing metadata (which Device ↔ which Host). A compromised VPS — and "your own VPS" is still a box on the internet that can be popped — **cannot read scrollback or forge a `send`.** Consequences: the Relay cannot inspect content (so semantic rate-limiting can't live there, see rule 5), and **push payloads are metadata-only** (rule 6).

### 3. Remote is a distinct **Origin**, governed by a deny-by-default per-op policy

Every bus request injected by the Bridge is tagged **`origin: device:<name>`** (vs. `origin: local` for socket/pane callers), and `paneControl.dispatch` branches on it. **How that tag is carried is a security property, not an implementation detail — see 3.1 before writing any of it.**

**Do not reason about remote risk in terms of the existing guardrails.** Only three ops carry a `window.confirm` (`spawn`, destructive `broadcast`, gated `send`); every *other* op — `read`, `gate.set`, `role.set`, `focus`, the blackboard — is unguarded **because ADR-0007 made guarding pointless**: the caller was "exactly the set of principals who can already drive the user's terminals by other means." Rules 1 and 2 repeal exactly that premise. Inheriting the guardrail set would therefore inherit an **allowlist-by-omission from a trust model this ADR overturns**, with two concrete holes: a remote `read` would ship 2000 lines of scrollback — the very secrets rule 2 exists to protect — with no approval at all; and `gate.set {on:false}` + `send` would walk straight through the gate in two ungated calls.

So remote authority is **enumerated per op, and fails closed**. An op earns a disposition only by having **both a demonstrated remote use case and a surface in the app that invokes it** — never by merely existing and looking survivable:

| Disposition | Ops | Earns it by |
|---|---|---|
| **`allow`** — no prompt | `list` (payload extended — see below) | the one reader; feeds the fleet-list screen |
| **`approve`** — Confirmation (3.3) | `send` (destructive only), `read` (Read Window) | the Pane-detail screen (read tail + send box) |
| **`deny`** | `spawn`, `broadcast`, `status`, `attention`, `gate.set`, `gate.list`, `role.set`, `focus`, the blackboard, **and everything unlisted — including ops that do not exist yet** | no surface, no articulated need, or actively harmful |

**One reader, two writers, everything else closed** — that is the entire remote surface.

Note `status` and `attention` are **`deny` despite sounding like reads**: both are *setters* (`{op:"status",target,text}` rewrites a Pane's label; `{op:"attention",target,clear}` raises or clears its border). Granting them would let a Device rewrite labels and clear attention borders fleet-wide, unprompted, through a surface the app does not have. Judge an op by its payload, not its name — an earlier draft of this table got exactly this wrong, and `gate.list` with it (the fleet screen already receives `gated` from `list`).

**`list` must grow a payload before the fleet screen can exist.** It returns `{name, workspace, focused, live, role, gated}` today — **no `status`, no `attention`**. `FleetPanel` reads those straight from the TS store in-process and never needed them on the wire, so the observe half of this ADR — the half rule 3.4 promotes to *the* feature — currently has **no data source**. `list` gains `status`, `attention`, and the ADR-0008 Session state. This is opacity-safe (both are *pushed* signals, never parsed from output, per ADR-0008/ADR-0001) and it improves `loom list` locally on the way past.

The fail-closed default is the load-bearing part. CLAUDE.md documents bus growth as routine ("new bus ops extend `ControlRequest`… handle in `paneControl.ts`"), so a policy enumerating *guards* silently widens the remote surface every time someone follows the documented pattern correctly. A policy enumerating *ops* makes a new op remote-inert until someone rules on it. Adding a row is a decision; forgetting to is safe.

Note what the surface test buys over a danger-ranked table: **remote `spawn` — the silent-RCE primitive — is absent rather than gated**, and the `gate.set {on:false}` → `send` bypass is *absent* rather than gated. Ranking ops by danger would have put both in `approve`, granting remote authority to ops nothing in the app can even invoke. That is allowlist-by-omission again, one level up. If remote `spawn` is ever wanted it costs a deliberate table row **and** a deliberate screen — the right ceremony for an RCE primitive.

`broadcast` is denied on its own record: the human broadcast bar was **removed 2026-06-25 as unused** (ASSESSMENT.md), and the stated reason was structural — multi-agent work is cross-*project*, which a single-Workspace fan-out "never served anyway." `ControlRequest.broadcast` is still single-Workspace, so a phone screen would rebuild the exact limitation that made the bar useless, on a worse keyboard. (It also cannot send Ctrl-C — it appends `\r` — so it does not serve the one plausible remote case, "stop everything.") Agent-driven `loom broadcast` is local-origin and unaffected.

**`read` runs under a time-boxed Read Window — required, not conditional.** A Confirmation per `read` collapses the moment the app is actually usable: swiping between Panes is the natural way to scan a Workspace, and a six-Pane Workspace would cost six taps. So `read`'s `approve` resolves **once** into a **Read Window** — default **15 minutes**, after which the next `read` re-prompts.

This is **not** a demotion to `allow`: the window expires, it is revocable, it is scoped to one Pairing, every read inside it is still **audited** individually (rule 4), and it is still rate-limited (rule 5). Nor is it a general unlock — `send` still Confirms every time.

**The duration is a security parameter, not a comfort setting**: it is exactly the span in which a stolen, unlocked phone can page through every Pane's scrollback unchallenged. 15 minutes is the default for that reason, not because it felt convenient. The Device is still held to a stricter standard than the laptop, where anyone at the keyboard reads freely — a phone is lost far more easily, and rule 6.6's revocation only helps once the loss has been *noticed*.

#### 3.1 Origin is envelope metadata, never request payload

`control.rs` is, by ADR-0007's design, a dumb forwarder: it hands the webview **the raw request string**, and `paneControl.ts` does `JSON.parse(request) as ControlRequest`. Therefore **`ControlRequest` must never gain an `origin` field.** A field on the request is a field in caller-authored JSON — a Device appending `"origin":"local"` would skip the table above and inherit ADR-0007's full ambient authority. Every control in this rule, bypassed by one extra key.

- **The envelope carries it.** `ControlEvent { req_id, request, origin }` is authored by **Rust**, set from *which transport the frame arrived on*: `local` from the unix socket (`control.rs`), `device:<name>` from the Bridge. Dispatch takes it as a parameter — `dispatch(req: ControlRequest, origin: Origin)`, never a property. Forgery becomes **unrepresentable** rather than blocked by a check someone can forget; a stray `"origin"` key parses into a field nothing reads.
- **The Device name is derived, not asserted.** `<name>` is resolved by looking the **authenticated Noise static key** up in the Host's `devices` table (rule 6.1) *after* the handshake completes. Taking it from the frame would let Device A file commands under Device B's name — the same bug one level down, landing in the audit trail rule 4 calls mandatory. Origin is derived from cryptographic identity.
- **ADR-0007's "pure relay" is amended.** Its "Rust attaches no caller identity" no longer holds — Rust now attaches transport-level identity. This does **not** breach the golden split: Rust states a transport fact ("this frame came off the Bridge, from the Device holding key X"), TS decides what it permits.

The general rule, since this class of bug recurs: **where the transport is deliberately a dumb string-forwarder, trusted metadata must travel in a channel the sender cannot write to.** ADR-0007 could forward raw strings safely *precisely because* it had no trusted metadata to protect. This ADR introduces the first piece, into a pipe built on the assumption that none exists.

#### 3.2 Two flows, and only one of them needs a new principal

A guardrail is an authorization boundary **only when the actor and the decider are different principals**. Locally that holds: an Agent calls `spawn`, and the *human at the laptop* decides — which is why `paneControl.ts` calls unguarded spawn "a silent-RCE primitive if an untrusted/poisoned agent holds the bus." Remote control contains two flows, and conflating them produces a control that is theatre in one and absent in the other.

#### 3.3 Flow A — remote-origin: a **Confirmation**, not an authorization boundary

The Device sends `send`/`spawn`/`broadcast`; the `approve` disposition parks it and prompts — **on the Device that just sent it**. Actor and decider are the same human on the same phone, so this is a **Confirmation**: it catches a fat-fingered `rm -rf` fanned to twelve Panes on a small screen, which is worth having and is *all* it is. It stops no attacker: whoever holds the unlocked phone taps Approve.

**Flow A's security therefore comes from rules 6, 3, and 4 — pairing, the deny-by-default table, and audit — never from the tap.** The ADR must not claim otherwise; an authorization control that only defends against its own operator's typos is one we would otherwise over-trust.

**Timeout: 60 s, default-deny.** The operator is holding the phone; silence means they abandoned the action.

**So `send` Confirms only when the text is destructive** — reuse `isDestructiveCommand` (`lib/guardrails.ts`), already backing the broadcast guard. Follow the logic through: a Confirmation stops no attacker (they tap it), so its *entire* value is typo protection — which means it should fire where typos hurt and nowhere else. Answering an Agent's question (`y`) is the hero flow (3.4) and must cost **one tap, no keyboard ceremony**; `rm -rf` still Confirms. Both are audited and rate-limited regardless.

#### 3.4 Flow B — local-origin, human away: **Clearances**, non-blocking

This is the flow that needs re-homing, and it is the hazard this ADR opened with: an Agent trips a guardrail while the laptop is unattended, `window.confirm` fires, and — being synchronous — it **blocks the webview thread, freezing every Pane's rendering until someone walks over**. Remote control makes this *more* likely to fire, since its whole premise is that you are elsewhere. Leaving the local branch on `window.confirm` would name the hazard and then preserve it.

So a tripped guardrail stops being a modal and becomes a first-class, non-blocking **Clearance**: a parked command awaiting a go/no-go, surfaced as an in-app panel on the laptop **and** pushed to any paired Device, resolvable from either, **default-denied** on timeout. Here actor (an Agent) and decider (you, wherever you are) are genuinely distinct — the boundary is real, and it is the *only* place remote control adds an authorization principal rather than relocating one.

**Flow B is worth building with no Device paired at all.** A synchronous modal that freezes every Pane is a defect on its own merits; `paneControl.ts` already documents that dispatch's reply blocks on it. That makes Clearances a **local** correctness fix that remote control merely gives a second surface — not new remote machinery.

**A Clearance must never outlive its caller — bind it to caller liveness, not a wall clock.** "Waits forever" is fiction, and the real bound is far shorter than the caller's own tool timeout: **`control.rs` parks a socket caller for `REPLY_TIMEOUT = 10s`** and then answers `"timed out waiting for app"` on its behalf. Ten seconds. A second, wall-clock timeout inside Loom would merely race that with a different wrong number. So a Flow B Clearance lives exactly as long as something is actually waiting on the reply; when the caller vanishes (reply timeout, killed CLI, dead Pane) it is **withdrawn — not denied**, because no decision was made.

**This is a live defect, not a hypothesis.** Today: an Agent runs `loom spawn`; `window.confirm` freezes the webview; at 10 s Rust gives up and tells the Agent it failed; the operator returns at minute 45 and clicks Allow — and `dispatch` **spawns the pane anyway**, then discards the reply because the sender is gone. A command runs three quarters of an hour late that nobody awaits and the asking Agent was told had failed. P0b must fix this; the Clearance model is how.

**This obliges `control.rs` to signal caller-disconnect *before* the frontend executes.** Today the accept thread parks on a channel and only learns the socket is dead when it writes the reply back — too late. Approving a Clearance whose Agent gave up would **spawn the pane** and *then* fail to deliver the reply: a command runs that nobody awaits and no Agent learns of. A `loom://pane-cmd-abort { reqId }` (or equivalent) must withdraw the card first.

#### 3.5 What this means for the product — corrected

An earlier draft of 3.4 called Flow B "the feature." That over-reached, and the caller-timeout above is why. Two *different* things block an Agent, and only one survives a lunch break:

- **Blocked on its own stdin** — "Can I edit `config.ts`?" The Agent waits *indefinitely*. This is an **Approval** (ADR-0008; `stores/sessions` already carries `approvalRequest`/`approvalResolve`). Push → open app → answer → it proceeds. **Works at any delay.**
- **Blocked on a bus reply** — `loom spawn` trips a guardrail. This is a **Clearance**, and `control.rs`'s 10 s `REPLY_TIMEOUT` means it is answerable for **ten seconds**.

So: **Approvals are the remote payoff** — which is what Plan 02 said before this ADR muddied it — and **Clearances are principally a *local* fix.** That does not lower P0b's priority: a synchronous modal freezing every Pane's rendering is a defect on its own merits, and Clearances remain the right shape. It changes what the *app* is for. "Type commands into your fleet from a phone" (`send`/`read`, and the whole risk budget) stays **optional**; the hero is answering the Agent that is patiently waiting on you.

*(Note `approval.resolve` is **already a bus op** and does **not** answer anything — it marks the Task unblocked and clears attention. Answering still means `send`. A future `approval.answer` taking one of an Agent's offered choices would need ADR-0008's Approval to carry a `choices` list, which it does not; that is a separate arc, not v1.)*

### 4. Audit records Origin — mandatory, not optional

`AuditEntry` gains an `origin` field (`local` | `device:<name>`); `recordAudit` is called for remote-injected commands on the same timeline as local ones. A remote `broadcast` is visible, attributable, and distinguishable from a local one — both live in the Fleet panel and in the after-the-fact record. Without this the feature is unauditable, so it is a hard requirement of accepting this ADR, not a nice-to-have.

### 5. Rate-limiting splits by layer

Remote `send`/`broadcast` run commands in live shells, so they are rate-limited at **two** layers, matching where each layer can see:

- **Relay (coarse, blind):** a per-session **frame-rate** cap as a DoS floor. Content-agnostic (it only has ciphertext) — it bounds flooding, nothing semantic.
- **Bridge/TS `paneControl` (semantic):** limits on `send` and `read` — the only ops a Device can reach (rule 3) — applied after decryption, in TS, keeping policy in TS per no-product-logic-in-Rust. This is where "no more than N sends/sec from a Device" and the Clearance round-trip live. `read` deserves its own limit even though it only reads: it is the scrollback-exfiltration path rule 2 is built around.

### 6. Pairing: the QR is the only trust anchor

Pairing is an explicit, local, **in-person** act, and it is the **one** place trust enters the system. The Relay is never a party to it. The guarantee *"this is my Loom, not someone else's"* rests on a single physical fact: **a camera pointed at your own screen is an out-of-band channel no network attacker — including a popped VPS — can enter.** Everything below follows from that, and remote control stays **off by default** until the user both enables it and completes a pairing.

#### 6.1 Keys, and where they live

| Key | Lives | Notes |
|---|---|---|
| Bridge static X25519 (`S_L`/`P_L`) | laptop — `app_data_dir()/remote/identity.key`, mode 0600 | generated on first enable |
| Device static X25519 (`S_D`/`P_D`) | phone — app storage, **Keystore-*wrapped*** (see below) | **one keypair per Pairing** (rule 7) |
| Paired-Device record `{pid, P_D, label, created_at}` | laptop — `sessions.db`, new `devices` table | **public keys only** — no secret at rest |
| Relay tokens | see 6.4 | bearer; availability-only (rule 5) |

The Bridge's private key sits behind a 0600 file rather than an OS keyring, deliberately: it is guarded by **the same boundary ADR-0007 already rests on — the OS user.** Anything that can read that file can already drive every Pane through the local socket, so a keyring would be bolting a lock onto the back door of an open house — and on Linux it would drag in the libsecret system dep [ADR-0009](0009-sqlite-session-task-log.md) was careful to avoid.

**The Device key is Keystore-*wrapped*, not Keystore-*held* — and the distinction is not pedantry.** A hardware-backed Keystore key is valuable precisely because it is **non-extractable**: it never leaves the secure element, and callers ask Keystore to operate *on their behalf*. But a Noise handshake (6.3) running in the React Native app needs the raw 32 private-key bytes in memory to compute the DH. **A non-extractable key cannot be handed to a JS Noise library.** The two decisions are in direct tension, and "Keystore, hardware-backed" would have been a claim the implementation could not honour.

So, for v1: `S_D` lives in app storage **encrypted under a non-extractable Keystore AES key** bound to the device and its lockscreen; the app unwraps it into memory to run Noise. Stated plainly, that **defends the threat 6.6 actually names** — a lost or stolen phone, where the key file is inert without the Keystore key it was wrapped under — and **does not defend a rooted or malware-bearing phone**, which this ADR never claimed to. The alternative — a native Kotlin module driving Noise's DH through Keystore's key-agreement API — is deferred hardening, not v1: it is real native work, and Keystore's X25519/XDH support is recent enough (≈API 33) that it would also put a floor under supported devices. **Verify that API-level claim before relying on it.**

Note what the laptop stores per Device: a **public** key. A leak of `sessions.db` exposes no key material that can drive anything.

#### 6.2 The QR payload

```
loom://pair?v=1&relay=<wss url>&pid=<128-bit>&pk=<P_L>&s=<256-bit secret>&name=<label>
```

**Single-use, short-lived** (default 3 min). `pk` is the whole point of the scan: afterwards the phone holds the laptop's real public key, obtained *without the network's help*. Two independent values are derived from `s`, and **the Relay only ever learns the first**:

```
ticket = HKDF(s, "loom/relay-ticket/v1")   → proves to the Relay "I hold this QR"
psk    = HKDF(s, "loom/noise-psk/v1")      → never leaves the two endpoints
```

Splitting them is load-bearing, not hygiene. On a *first* pairing the laptop has no prior `P_D` to check against — it accepts the Device static the handshake carries. So a Relay that learned the PSK could complete a pairing **as a Device** and walk away holding a legitimate, fully-authorised pairing. HKDF under distinct labels means the ticket the Relay does see yields nothing about the PSK.

#### 6.3 The handshake — two regimes

Both run **through** the Relay, sealed:

- **First pairing — `Noise_XKpsk3_25519_ChaChaPoly_BLAKE2s`.** The phone initiates and already knows the responder's static (`P_L`, from the QR), which is precisely what XK assumes. `psk` binds the handshake to *this* QR, so possession of `P_L` — not a secret — is not enough to pair. The phone's `P_D` is transmitted **encrypted**, so the Relay never learns which Device paired. On success the laptop writes the `devices` row and mints that Device's durable Relay token, handing it back **inside** the sealed channel and registering only its hash with the Relay.
- **Every reconnect after — `Noise_KK_25519_ChaChaPoly_BLAKE2s`.** Both statics are known, so each session is mutually authenticated from the first message and forward-secret via fresh ephemerals. An unrecognised static fails **at the Bridge** — which is what makes revocation real (6.6).

A MITM at the Relay is not a threat we hope to *detect*; it is one the handshake **cannot be fooled by**. Impersonating the laptop needs `S_L`; impersonating the phone needs `S_D`; the Relay has neither and cannot obtain either. Misrouting — malicious or merely buggy — hands an undecryptable frame to the wrong endpoint and the connection fails. **The Relay's routing table is untrusted input.**

#### 6.4 Relay state — blind is not stateless

"Blind" (rule 2) bounds what the Relay may **know**, not whether it may **remember**. It keeps exactly:

| Entry | Value |
|---|---|
| `pending[pid]` | `{ ticket_hash, expires_at }` — written when the Bridge renders a QR; reaped on expiry |
| `pairing[pid]` | `{ bridge_token_hash, device_token_hash, push_token?, created_at, last_seen }` |

All of it is **routing metadata**; none of it decrypts a frame or forges a `send`. It **must survive a restart** — a `systemctl restart` that silently unpairs every Device is not acceptable — so the Relay persists it (SQLite or equivalent; the store is tiny and the pick is unconstrained).

**Enrollment.** The Relay holds an **enrollment key** (systemd `EnvironmentFile=`), which the Bridge presents to register a `pid`. This is not a boundary for your data — E2E already covers that — it is what stops the `relay.` subdomain being an open rendezvous for anyone who finds it.

#### 6.5 What the Relay's compromise costs

Availability, and nothing else. It cannot read scrollback (rule 2), forge a `send`, pair itself as a Device (6.2), impersonate either endpoint (6.3), or resurrect a revoked Device (6.6). It can drop frames and it can stall. That asymmetry is the entire justification for the E2E seal.

#### 6.6 Revocation is enforced at the Bridge

Settings lists paired Devices with a **Revoke**; it deletes the `devices` row. The next `KK` handshake from that Device presents an unrecognised static and **fails at the laptop** — so revocation depends on neither the Relay's honesty nor its reachability. The Bridge also asks the Relay to drop the `pid` (hygiene: frees the slot, stops the push fan-out), but a Relay that ignores the request has still lost.

#### 6.7 Push is metadata-only

An `attention` raise fans to the Device's push token as *"a Pane needs you"* with no plaintext — the Relay routes it and must stay blind — and the app fetches specifics over the E2E channel on open. The payload does carry `pid` (routing metadata, not content), because rule 7 makes "which Loom?" a real question.

### 7. One phone, N **Hosts** — Pairings are independent

A phone pairs with the work laptop *and* the home desktop; the model must not assume one of each. The domain terms are fixed in CONTEXT.md and this ADR uses them precisely: a **Host** is one running Loom; a **Device** is a paired remote principal *as one Host knows it*; a **Pairing** is the Host↔Device relationship the QR establishes. **A Device is not a phone.** One phone holds N Pairings and therefore appears as **N unrelated Devices** across N Hosts.

Each Pairing is fully independent — its own `pid`, its own `P_L`, **its own Device keypair**, optionally its own Relay. The justification for a fresh `S_D` per Pairing is **revocation independence**: revoking the phone at work leaves the home Pairing untouched.

*(An earlier draft also claimed two Hosts "cannot correlate the same phone by a shared static key." That is true of the static key and false of the system — the FCM registration token is per app-install, not per Pairing, so both Relays see the same push token. Harmless for a single-user product, since you own both Hosts, but it is not a security property and is not claimed as one.)*

This reaches back into the other rules:

- **The app is Host-scoped.** It holds a list of `Pairing { pid, relay_url, label, P_L, S_D }`, and every screen acts on the selected one. Labels are mutable and come from the QR; **identity is `P_L`**, so the picker shows a **key fingerprint** beside the label — two Hosts will both be called "laptop".
- **Clearances are attributed** (rule 3.4). The inbox must say *which* Host is asking before you decide; an unattributed prompt is unanswerable once two Hosts are paired, and default-deny makes a confused tap the expensive kind of mistake.
- **Audit is per-Host** (rule 4). `origin: device:<name>` is recorded on the Host that executed the command, and `<name>` is **Host-local** — so two Hosts may each hold a "kim-pixel" with no collision, and no global namespace is needed. The phone keeps no merged log.
- **Different Hosts may use different Relays.** `relay_url` is per-Pairing, so a work laptop behind one VPS and a home box behind another works by construction.

## Why not the obvious alternatives

- **Put the bus on a plain WebSocket / LAN-only (Plan 02 P1's throwaway step).** Fine as a de-risking spike on trusted Wi-Fi, but not shippable: no auth, and it inherits ADR-0007's "network exposure = same-user-authority-to-anyone-on-the-LAN" problem. P1 is explicitly a validation step, not the product.
- **Inbound port + port-forward / Tailscale.** Requires the user to open a port or run a mesh VPN; "from anywhere with zero laptop network config" was the goal, and dial-out delivers it with a smaller laptop attack surface (rule 1).
- **TLS-to-relay-only (no E2E).** Simpler, and lets the Relay rate-limit on content — but the VPS then sees every scrollback tail and can forge sends. That is *weaker* than the same-user boundary ADR-0007 started from, for a feature that ships secrets over the wire. Rejected (rule 2).
- **Let remote commands trigger the existing desktop confirm.** Hangs the webview thread on an unattended laptop (see Context) — the whole reason for rule 3. Note the sharper form: this is *also* true of **local** commands once you accept that the operator is away, which is why rule 3.4 makes Clearances non-blocking for both Origins rather than bolting a remote branch onto a synchronous modal.
- **Rely on the existing guardrail set to bound remote risk.** It is an allowlist-by-omission inherited from ADR-0007's repealed premise: `read` would ship 2000 lines of scrollback unguarded, and `gate.set {on:false}` + `send` would walk through the gate in two calls. Hence the deny-by-default op table (rule 3).
- **Treat the remote approve/deny tap as an authorization control.** Actor and decider are the same human on the same phone (rule 3.3); a thief taps Approve. Kept as a Confirmation, but the ADR must not bank security on it.
- **A full per-Pane capability system** (ADR-0007's "tracked, not built" future). Still deferred; the Origin tag + the deny-by-default op table (rule 3) is the minimum that makes remote safe without it — note the table is a coarse, Host-wide capability set, and a per-Pane one is the natural next step if `deny` ever proves too blunt.

## Consequences

- **ADR-0007's one-sentence trust model no longer holds globally.** It remains true for local-origin bus traffic; remote-origin traffic is governed by *this* ADR (pairing, E2E, per-command approval, audited origin) instead of "the OS user." Update the cross-reference in 0007 when this is accepted.
- **`paneControl.dispatch` becomes origin-aware and gains a policy table.** Dispatch takes `origin` **as a parameter from the Rust-authored envelope** — the request type must *not* gain an `origin` field (rule 3.1: the body is caller-authored, so a field there is forgeable). It consults the per-op disposition (rule 3) before executing. This is the one place the golden split's "routing in TS" now also carries *policy* differences by origin — deliberately, because policy is product logic.
- **`control.rs` gains caller-disconnect detection** (rule 3.4) — a parked Clearance must be withdrawn the moment its caller stops waiting, *before* any Approve can execute it. This is new behaviour in the accept thread, which currently only discovers a dead socket on reply-write.
- **`control.rs`'s `ControlEvent` gains a Rust-authored `origin`** (rule 3.1), and ADR-0007's "Rust attaches no caller identity (it's a pure relay)" is amended: Rust now attaches transport identity, TS still owns all policy. Update 0007's cross-reference on acceptance.
- **The three guardrail helpers stop being synchronous** (rule 3.4). `confirmExternalSpawn`, `confirmDestructiveBroadcast`, and `confirmHeldPaneInput` currently call `window.confirm`, which blocks the webview thread and stalls dispatch's reply; they become non-blocking **Clearances** — parked state, an in-app panel, an optional Device push, default-deny on timeout — for **both** Origins. This is the largest single change to existing code in this ADR, and it is a **local** correctness fix (a modal that freezes every Pane's rendering is a defect with or without a phone); remote merely adds a second surface to answer on.
- **Clearance vs Approval is a live terminology hazard.** ADR-0008's Approval (an Agent, blocked, describing its own work) and a Clearance (Loom, holding a command, asking permission) are different entities that both want to be called "the thing in the inbox." CONTEXT.md now separates them; the app must not merge them into one undifferentiated list.
- **`AuditEntry`/`recordAudit` extend with `origin`** (rule 4). The Fleet panel's audit view should surface it. **Open issue:** `stores/audit.ts` is today a 500-entry in-memory ring, cleared on restart — there is no "after-the-fact record" for rule 4 to be a hard requirement *of*. Persisting audit rows (naturally: a third table in the ADR-0009 `sessions.db`, same TS-drives/Rust-stores path, same prune policy, still nowhere near the byte hot path) is a **prerequisite of accepting this ADR**, not follow-up work.
- **`sessions.db` gains a `devices` table** (rule 6.1) — `{pid, P_D, label, created_at}`, public keys and metadata only. This is the second use of the ADR-0009 store beyond agent history; that store becomes "the durable local record," not just the session log.
- **New crypto deps on the laptop:** a Noise implementation (`snow` covers XKpsk3 + KK over 25519/ChaChaPoly/BLAKE2s) and a QR renderer. Both are pure-Rust — no system libs, consistent with the bundled-SQLite precedent.
- **The app carries unbudgeted work the "native app" decision hides:** a Noise implementation in JS, Keystore wrapping (6.1), a QR scanner, and — because there is no xterm.js on React Native — **an ANSI renderer for the Pane-detail screen**. `read` returns raw terminal bytes; something must draw them on a phone. This is opacity-safe (rendering is not parsing-for-product-logic, exactly as xterm.js is), but it is not free.
- **New moving parts to operate:** a Go WS-proxy Relay (systemd unit behind the existing nginx/certbot on the Plan 03 VPS, a `relay.` vhost) with **persisted pairing state and an enrollment key** (rule 6.4), a React Native app (Android first; iOS later behind APNs), and key storage on both ends. The Relay stays ~a few hundred lines *because* it is blind — it pairs sessions and forwards ciphertext, nothing more.
- **The app is Host-scoped from v1** (rule 7), not retrofitted: a Pairing list, a Host picker, fingerprints beside labels (identity is `P_L`, not the label), and `pid` on every push and Clearance.
- **nginx's `proxy_read_timeout 3600s`** (Plan 03) will drop an idle dial-out connection after an hour, and an idle fleet is silent for hours — the Bridge needs its own ping/pong well under that, or the phone finds the laptop "offline" every morning.
- **Opacity is intact.** `read` still ships bytes only on explicit request and Loom never parses them; E2E just means those bytes are sealed to the VPS. ADR-0001 is untouched.
- **Linux-first still holds on the laptop** (the Bridge dials out from the same process that owns the unix socket); the Relay and app are new, separate deployables.

## Phasing (mirrors [Plan 02](../roadmap/plans/02-mobile-remote.md), de-risk in order)

The Relay's **location** is not a phase: build dial-out + blind-relay + E2E from the start and run the Relay on localhost/LAN while iterating — going live is a `scp`, not a redesign. A LAN-only *product* is rejected twice over (see alternatives above, and rule 1's no-listening-socket property).

- **P0 — audit persistence.** Rule 4's "after-the-fact record" does not exist yet (`stores/audit.ts` is a 500-entry in-memory ring). A prerequisite of this ADR, not follow-up.
- **P1 — LAN bridge (spike):** verbs over a local WebSocket, proven from a script — or a phone browser, which is the cheap way to answer "does this feel good?" No Relay, no auth, no E2E; **not shippable.**
- **P2 — Relay + pairing + E2E:** dial-out, QR pairing (rule 6), persisted Relay state + enrollment key, Bridge ping/pong, origin tagging + audit, Clearances over the wire. First shippable, safe state.
- **P3 — React Native app** over P2 (Android first), Host-scoped per rule 7.
- **P4 — Push:** `attention` → metadata-only push (+ `pid`) to the paired Device.

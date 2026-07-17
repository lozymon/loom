# Review brief — `lansec.rs` (LAN bridge sealing)

> **Purpose:** give a reviewer with crypto background everything needed to audit the LAN bridge's
> confidentiality/authentication layer efficiently. This is a **request for review**, not a findings
> report. Written by the implementer (Claude) — treat the "why this is fine" claims as *the design's
> assertions to be checked*, not established facts.
>
> **Scope:** `src-tauri/src/lansec.rs` (the sealing), plus the handshake wiring in
> `src-tauri/src/lanbridge.rs` (`handle_ws`) and the JS client `mobile/src/lib/lanClient.ts`. The
> from-anywhere Noise design (ADR-0012 rule 6) is **out of scope** — separate, also unreviewed.

## What it is, in one paragraph

The local-first mobile app (Plan 02) drives a Loom fleet over a WebSocket on the same LAN. Because
`read` ships terminal scrollback (secrets, tokens, live `ssh`), the LAN must not carry plaintext even
at home. This layer provides confidentiality + authentication from a **pre-shared key (PSK)** — a
32-byte pairing key the laptop shows as a QR and the phone scans once. It is deliberately *not* the
flagship's Noise handshake; it is a simpler PSK+AEAD construction judged adequate for the LAN threat
model. The core question for the reviewer: **is that judgement right, and is the construction
implemented without the standard AEAD/replay footguns?**

## Threat model

**In scope (must defend):**
- A passive eavesdropper on the Wi-Fi (reads frames) — must not learn scrollback or commands.
- An active attacker on the LAN without the PSK — must not be able to drive the fleet (inject/forge
  commands) or impersonate the laptop.
- Replay of captured frames.

**Explicitly out of scope (accepted):**
- **Forward secrecy.** The session key derives deterministically from the PSK, so an attacker who
  records ciphertext *and later* obtains the PSK can decrypt those sessions. Accepted because the PSK
  is local, revocable, and re-pairable; the from-anywhere path uses Noise instead. **Please confirm
  this tradeoff is stated correctly and has no worse consequence than described.**
- A compromised endpoint (rooted phone / malware on the laptop). The PSK is at rest on both ends.
- LAN-level denial of service (see the DoS note below — flagged, not solved).

## The exact construction

**Pairing.** Laptop generates a random 32-byte PSK (`random32()` → `getrandom::fill`), persists it
0600 at `app_data_dir/lan-pairing.key`, and encodes `{url, host, port, key(base64)}` in a QR. The
phone stores the key in `expo-secure-store` (Android Keystore-backed). Revocation deletes the key on
both ends.

**Per-connection handshake** (`lanbridge.rs::handle_ws`, mirrored in `lanClient.ts`):
1. Client → server: 32 random bytes `client_salt` (cleartext, first WS binary frame).
2. Server → client: 32 random bytes `server_salt` (cleartext).
3. Both derive `session_key = HKDF-SHA256(ikm = PSK, salt = client_salt ‖ server_salt, info =
   "loom-lan-v1", L = 32)`. Note HKDF is used with the **PSK as IKM** and the two public salts as the
   HKDF salt.

**Framing** (`lansec.rs::Sealed`): every control frame is `[counter(8, big-endian)] ‖
ChaCha20-Poly1305(session_key, nonce, payload)`.
- Nonce (12 bytes): `[direction(1)] ‖ [counter(8, big-endian)] ‖ [0,0,0]`, `direction` = 0 for
  client→server, 1 for server→client.
- Counters are **per-direction, per-connection**, starting at 0, incremented per frame.
- Receiver (`open`) rejects a frame whose counter is `<= the last accepted counter` (strictly
  increasing) — replay/reorder protection *within a connection*.

**Authentication is implicit:** a party without the PSK derives a different `session_key`, so every
frame it sends fails the Poly1305 tag check → the server drops the connection. There is no separate
signature or MAC-of-transcript.

## Why the design believes this is sound (please verify each)

1. **No nonce reuse under a key.** The session key is unique per connection (fresh 32-byte salts on
   both sides), so counters restarting at 0 each connection never collide *across* connections; the
   `direction` byte separates the two senders' counters *within* a connection. → Verify there is no
   path to nonce reuse.
2. **Authentication.** Only a PSK-holder can produce frames that decrypt. First client frame that
   `open()`s successfully proves the client holds the PSK. → Verify no unauthenticated action happens
   before that first successful `open()` (the server *does* send `server_salt` before authenticating
   the client — see Q1).
3. **Replay.** Strictly-increasing counter within a connection; cross-connection replay fails on the
   different session key. → Verify.
4. **Tamper.** The counter prefix is cleartext and attacker-malleable, but it *is* the nonce, so
   flipping it changes the nonce → tag mismatch → reject. → Verify this reasoning (no AAD is used; is
   that OK given the nonce derives from the counter?).

## Specific things to scrutinise (the implementer's own doubts)

- **Q1 — Unauthenticated salt exchange.** The salts are exchanged in cleartext *before* either side
  is authenticated. An active MITM can tamper them; the claim is this only causes a derived-key
  mismatch → both sides fail to decrypt → connection dies (DoS), never a compromise. **Is that the
  only consequence?** Is there any transcript-substitution or unknown-key-share concern given the PSK
  is symmetric and shared?
- **Q2 — Counter wrap.** `send_ctr` uses `wrapping_add` (`lansec.rs`), so at 2^64 frames it wraps to
  0 → nonce reuse under the same session key. Astronomically unreachable on one connection, but it is
  a *silent* reuse rather than a hard failure. Should it abort the connection near `u64::MAX` instead?
- **Q3 — First-frame counter.** `open()` accepts *any* counter on the first frame (`recv_started`
  false), then requires strictly increasing. An attacker can't exploit it (no key), but confirm no
  edge case (e.g. a first frame with counter `u64::MAX` then nothing else accepted).
- **Q4 — HKDF usage.** IKM = PSK, salt = concatenated public salts, info = a fixed label. This is the
  "salt is public, IKM is the secret" orientation — believed correct, but confirm it's the intended
  HKDF contract and that a fixed `info` across all connections is fine (the salt provides the
  per-connection uniqueness).
- **Q5 — RNG.** `random32()` calls `getrandom::fill(...).expect(...)` — a panic on RNG failure rather
  than a weak-salt fallback. Confirm `getrandom` is an acceptable CSPRNG here and panic-on-failure is
  the right posture.
- **Q6 — DoS / resource use.** The bridge is thread-per-connection with no connection cap or rate
  limit; an unauthenticated LAN peer can open connections and force salt generation + a failed
  decrypt each. Bounded work per connection, but no global limit. Is a cap needed for the LAN threat
  model, or is "it's your home LAN" acceptable?
- **Q7 — Key at rest.** Laptop: 0600 file under `app_data_dir` (guarded by the OS user, consistent
  with ADR-0007). Phone: `expo-secure-store`. Adequate?
- **Q8 — Library usage.** Rust side uses RustCrypto `chacha20poly1305` + `hkdf` + `sha2`; the JS
  client uses `@noble/ciphers` + `@noble/hashes`. Confirm both are used correctly (12-byte nonce, tag
  appended/verified, no truncation) and that the two implementations are byte-compatible (they are
  interop-tested — see below — but a review of the *usage* is still wanted).

## Evidence it works (functionally, not a security proof)

- Rust unit tests (`lansec.rs` `#[cfg(test)]`): round-trip, wrong-PSK-fails-the-tag, replayed-counter-
  rejected, distinct-salts-yield-distinct-keys.
- **Cross-language interop** proven live three ways: the Rust server, a Python client
  (`cryptography` lib), and the actual RN client (`@noble`) all interoperate against a running bridge
  — correct key round-trips a sealed `list`, wrong key is dropped. This is evidence the *wire format*
  is unambiguous; it is **not** evidence the *design* is sound. That's what this review is for.

## Files

- `src-tauri/src/lansec.rs` — derivation, nonce, seal/open, the unit tests.
- `src-tauri/src/lanbridge.rs` — `handle_ws` (the handshake sequence), key persistence, LAN binding,
  `lan_bridge_enable`/`unpair` (pairing/revocation).
- `mobile/src/lib/lanClient.ts` — the JS client's mirror of the same scheme.
- Design rationale + accepted tradeoffs: the module doc-comment at the top of `lansec.rs`.

## The ask

1. Is the **PSK + per-connection-HKDF + counter-nonce AEAD** construction adequate for the stated LAN
   threat model, or does it need to move to an authenticated handshake (e.g. Noise `NNpsk0`/`KKpsk`)
   even for LAN?
2. Are Q1–Q8 real issues, and which are blocking vs. acceptable-with-a-note?
3. Anything the threat model omits that a home-LAN attacker could actually do.

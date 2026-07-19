// The sealed LAN-bridge client (Plan 02 L2) — the phone half of the L1c wire protocol. It is the
// THIRD independent implementation of that scheme (Rust `lansec.rs`, the Python interop test, and
// this), so it must match byte-for-byte:
//
//   1. open a WebSocket, send our 32-byte client_salt (raw, first frame)
//   2. receive the server's 32-byte server_salt
//   3. session_key = HKDF-SHA256(ikm=PSK, salt=client_salt‖server_salt, info="loom-lan-v1", 32)
//   4. every frame: [counter(8, big-endian)] ‖ ChaCha20-Poly1305(key, nonce, payload)
//      nonce = [direction(1)] ‖ [counter(8, big-endian)] ‖ [0,0,0]   (client→server dir=0, server→client dir=1)
//
// Pure JS via @noble (no native module), so the exact same file runs in React Native AND in Node —
// which is how `verifyBridge.ts` proves interop against a live Loom without an emulator.

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import type { AppRequest, AppResponse } from "../protocol";

const INFO = new TextEncoder().encode("loom-lan-v1");
const DIR_CLIENT_TO_SERVER = 0;
const DIR_SERVER_TO_CLIENT = 1;

/** How long to wait for the WebSocket + salt handshake before giving up. A stale/unreachable
 *  address leaves the socket in CONNECTING with no onerror/onclose for a long time (the SYN just
 *  goes unanswered), so without this the app hangs on "Connecting to Loom…" forever. */
const CONNECT_TIMEOUT_MS = 8000;

/** 12-byte nonce: [dir][counter big-endian (8)][0,0,0]. */
function nonce(dir: number, ctr: number): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = dir;
  new DataView(n.buffer).setBigUint64(1, BigInt(ctr), false);
  return n;
}

/** 8-byte big-endian counter prefix. */
function counterBytes(ctr: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(ctr), false);
  return b;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** base64 → bytes, environment-agnostic (atob in RN/browser, Buffer in Node). */
export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** 32 cryptographically-random bytes (the per-connection client salt). */
function randomSalt(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

/** Thrown when the bridge closes before/instead of answering — usually a wrong pairing key (every
 *  frame fails the AEAD tag, so the server drops us) or the bridge being off. */
export class BridgeError extends Error {}

/**
 * A live, sealed connection to one Loom's LAN bridge. The bridge handles frames strictly in order
 * (thread-per-connection, sequential relay), so calls resolve FIFO — no per-request id needed.
 */
export class LanBridgeClient {
  private ws: WebSocket | null = null;
  private cipherKey: Uint8Array | null = null;
  private sendCtr = 0;
  private recvCtr = 0;
  private clientSalt = randomSalt();
  private pending: Array<{ resolve: (r: AppResponse) => void; reject: (e: Error) => void }> = [];
  private onSaltResolve: (() => void) | null = null;
  private onSaltReject: ((e: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private url: string,
    private psk: Uint8Array,
  ) {}

  /** Connect and complete the salt handshake. Resolves once the channel is sealed and ready.
   *  Rejects (not hangs) if the bridge can't be reached within CONNECT_TIMEOUT_MS. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.onSaltResolve = resolve;
      this.onSaltReject = reject;
      this.connectTimer = setTimeout(
        () => this.fail(new BridgeError(`couldn't reach Loom at ${this.url} (timed out)`)),
        CONNECT_TIMEOUT_MS,
      );
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => ws.send(this.clientSalt);
      ws.onmessage = (ev) => this.onMessage(new Uint8Array(ev.data as ArrayBuffer));
      ws.onerror = () => this.fail(new BridgeError("connection error"));
      ws.onclose = () => this.fail(new BridgeError("connection closed (wrong key, or bridge off?)"));
    });
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private onMessage(frame: Uint8Array) {
    if (!this.cipherKey) {
      // Handshake: this frame is the server_salt.
      if (frame.length !== 32) return this.fail(new BridgeError("bad server salt"));
      const salt = concat(this.clientSalt, frame);
      this.cipherKey = hkdf(sha256, this.psk, salt, INFO, 32);
      this.clearConnectTimer();
      const r = this.onSaltResolve;
      this.onSaltResolve = null;
      this.onSaltReject = null;
      r?.();
      return;
    }
    // A sealed reply: [ctr(8)][ciphertext].
    const waiter = this.pending.shift();
    if (!waiter) return;
    try {
      const ctr = Number(new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0, false));
      const pt = chacha20poly1305(this.cipherKey, nonce(DIR_SERVER_TO_CLIENT, ctr)).decrypt(
        frame.subarray(8),
      );
      waiter.resolve(JSON.parse(new TextDecoder().decode(pt)) as AppResponse);
    } catch (e) {
      waiter.reject(e instanceof Error ? e : new BridgeError(String(e)));
    }
  }

  /** Send one request and await its reply. */
  call(req: AppRequest): Promise<AppResponse> {
    if (!this.ws || !this.cipherKey) return Promise.reject(new BridgeError("not connected"));
    const pt = new TextEncoder().encode(JSON.stringify(req));
    const ctr = this.sendCtr++;
    const sealed = chacha20poly1305(this.cipherKey, nonce(DIR_CLIENT_TO_SERVER, ctr)).encrypt(pt);
    const frame = concat(counterBytes(ctr), sealed);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.ws!.send(frame);
    });
  }

  /** Tear the connection down. Safe to call while still connecting — it aborts the in-flight
   *  handshake (so a "Cancel" on the connecting screen resolves immediately) as well as on teardown. */
  close() {
    this.clearConnectTimer();
    this.ws?.close();
    this.fail(new BridgeError("cancelled"));
  }

  private fail(err: Error) {
    this.clearConnectTimer();
    this.onSaltReject?.(err);
    this.onSaltResolve = null;
    this.onSaltReject = null;
    while (this.pending.length) this.pending.shift()!.reject(err);
  }
}

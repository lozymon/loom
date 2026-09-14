import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { WebSocket } from "ws";
import type { Duplex } from "node:stream";
import { withPrefix } from "./prefixed.ts";

export type RelayStatus =
  | { kind: "connecting" }
  | { kind: "up"; hostname: string }
  | { kind: "down"; reason: string; retryInMs: number };

export interface RelayClientOptions {
  /** `wss://relay.example.com` */
  url: string;
  name: string;
  secret: string;
  /** A visitor connection: TLS for the hub's HTTPS server, or plain HTTP for ACME challenges. */
  onStream(kind: "tls" | "http", socket: Duplex, visitor: string): void;
  onStatus(status: RelayStatus): void;
  /** Extra trusted CAs for the relay's own certificate (tests). */
  ca?: Buffer[] | undefined;
  /** Name resolution for the relay host (tests, split DNS). */
  lookup?: import("node:net").LookupFunction | undefined;
}

type ControlMessage = { t: "welcome"; hostname: string } | { t: "open"; stream: string; kind: "tls" | "http"; visitor: string };

/**
 * The hub's side of the relay (ADR-0014): one control WebSocket, dialed out and kept up, and a data
 * connection opened back to the relay for each visitor.
 */
export class RelayClient {
  #opts: RelayClientOptions;
  #ws: WebSocket | undefined;
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #closed = false;
  #base: URL;

  constructor(opts: RelayClientOptions) {
    this.#opts = opts;
    this.#base = new URL(opts.url);
    if (this.#base.protocol !== "wss:") throw new Error("relay.url must start with wss://");
  }

  #headers() {
    return { authorization: `Bearer ${this.#opts.secret}`, "x-loom-hub": this.#opts.name };
  }

  start(): void {
    if (this.#closed) return;
    this.#opts.onStatus({ kind: "connecting" });
    const ws = new WebSocket(new URL("/v1/hub", this.#base.href.replace(/^wss:/, "https:")).href.replace(/^https:/, "wss:"), {
      headers: this.#headers(),
      handshakeTimeout: 15_000,
      ...(this.#opts.ca ? { ca: this.#opts.ca } : {}),
      ...(this.#opts.lookup ? { lookup: this.#opts.lookup } : {}),
    });
    this.#ws = ws;
    let reason = "connection lost";
    let refused = false;
    ws.on("unexpected-response", (_req, res) => {
      refused = true;
      reason = res.statusCode === 401 ? "the relay does not know this hub or its secret (run loom-relay add-hub)" : `the relay answered ${res.statusCode}`;
      res.resume();
      ws.terminate();
    });
    ws.on("error", (err) => {
      if (!refused) reason = err.message || (err as NodeJS.ErrnoException).code || "cannot reach the relay";
    });
    ws.on("message", (data) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(String(data)) as ControlMessage;
      } catch {
        return;
      }
      if (msg.t === "welcome") {
        this.#attempt = 0;
        this.#opts.onStatus({ kind: "up", hostname: msg.hostname });
      } else if (msg.t === "open" && /^[0-9a-f]{32}$/.test(msg.stream)) {
        this.#dialBack(msg.stream, msg.kind === "http" ? "http" : "tls", String(msg.visitor ?? "unknown"));
      }
    });
    ws.on("close", (code, why) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      if (this.#closed) return;
      if (code === 4000) reason = "another connection for this hub name replaced this one";
      else if (why.length && !refused) reason = why.toString();
      const retryInMs = Math.min(60_000, 1000 * 2 ** Math.min(this.#attempt++, 6));
      this.#opts.onStatus({ kind: "down", reason, retryInMs });
      this.#timer = setTimeout(() => this.start(), retryInMs);
    });
  }

  #dialBack(stream: string, kind: "tls" | "http", visitor: string): void {
    const req = httpsRequest({
      host: this.#base.hostname,
      port: this.#base.port || 443,
      servername: this.#base.hostname,
      path: `/v1/stream/${stream}`,
      method: "GET",
      headers: { ...this.#headers(), connection: "Upgrade", upgrade: "loom-stream" },
      timeout: 10_000,
      ...(this.#opts.ca ? { ca: this.#opts.ca } : {}),
      ...(this.#opts.lookup ? { lookup: this.#opts.lookup } : {}),
    });
    req.on("upgrade", (_res, socket: TLSSocket, head: Buffer) => {
      this.#opts.onStream(kind, withPrefix(socket, head), visitor);
    });
    req.on("response", (res) => {
      res.resume();
      req.destroy();
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => undefined);
    req.end();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "hub stopping");
  }
}

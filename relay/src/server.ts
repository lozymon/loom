import { randomBytes } from "node:crypto";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_HELLO_BYTES, parseClientHello, parseHttpHead } from "./clientHello.ts";
import type { HubRegistry } from "./registry.ts";
import { withPrefix } from "./prefixed.ts";

export interface RelayLimits {
  /** Open connections from one visitor address. */
  perVisitor: number;
  /** Streams waiting for their hub to dial back. */
  pendingPerHub: number;
  /** Spliced streams per hub. */
  streamsPerHub: number;
  /** Time to send a ClientHello or HTTP request head. */
  helloMs: number;
  /** Time for the hub to open the data connection. */
  dialBackMs: number;
  /** A spliced stream with no traffic this long is closed. */
  idleMs: number;
  /** Control connection ping interval; two missed pongs close it. */
  pingMs: number;
  /** Failed enrollments from one address before it waits. */
  authFailures: number;
}

const DEFAULT_LIMITS: RelayLimits = {
  perVisitor: 64,
  pendingPerHub: 32,
  streamsPerHub: 512,
  helloMs: 10_000,
  dialBackMs: 10_000,
  idleMs: 30 * 60_000,
  pingMs: 25_000,
  authFailures: 20,
};

export interface RelayOptions {
  /** The relay's own name, e.g. `relay.example.com`. Hubs are `<name>.<domain>`. */
  domain: string;
  /** Certificate for `domain` itself, for the control and data endpoints. Never used for hub names. */
  tls: { cert: Buffer | string; key: Buffer | string };
  host: string;
  httpsPort: number;
  /** Plain HTTP, for ACME challenges on hub names and redirects. */
  httpPort?: number | undefined;
  registry: HubRegistry;
  limits?: Partial<RelayLimits>;
  log?: (line: string) => void;
}

interface Pending {
  visitor: net.Socket;
  initial: Buffer;
  timer: NodeJS.Timeout;
}

interface HubLink {
  name: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
  active: number;
  missedPongs: number;
  ping: NodeJS.Timeout;
}

export interface Relay {
  httpsPort: number;
  httpPort: number | undefined;
  connectedHubs(): string[];
  /** Reloads the relay's own certificate, e.g. after certbot renewed it. */
  setCertificate(tls: { cert: Buffer | string; key: Buffer | string }): void;
  close(): Promise<void>;
}

const plain = (address: string | undefined) => (address ?? "unknown").replace(/^::ffff:/, "");

/** Starts the relay (ADR-0014): TLS passthrough for hub names, its own endpoints for hubs. */
export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? (() => undefined);
  const domain = opts.domain.toLowerCase();
  const hubs = new Map<string, HubLink>();
  const visitors = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const sockets = new Set<net.Socket>();

  const track = (socket: net.Socket): boolean => {
    const address = plain(socket.remoteAddress);
    const count = visitors.get(address) ?? 0;
    if (count >= limits.perVisitor) {
      socket.destroy();
      return false;
    }
    visitors.set(address, count + 1);
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      const n = (visitors.get(address) ?? 1) - 1;
      if (n <= 0) visitors.delete(address);
      else visitors.set(address, n);
    });
    socket.on("error", () => socket.destroy());
    return true;
  };

  const hubNameFor = (host: string): string | undefined => {
    if (!host.endsWith(`.${domain}`)) return undefined;
    const name = host.slice(0, -(domain.length + 1));
    return /^[a-z0-9-]+$/.test(name) ? name : undefined;
  };

  /** Asks the hub for a data connection and parks the visitor until it arrives. */
  const openStream = (name: string, kind: "tls" | "http", visitor: net.Socket, initial: Buffer) => {
    const hub = hubs.get(name);
    if (!hub || hub.pending.size >= limits.pendingPerHub || hub.active >= limits.streamsPerHub) {
      visitor.destroy();
      return;
    }
    const id = randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      hub.pending.delete(id);
      visitor.destroy();
    }, limits.dialBackMs);
    hub.pending.set(id, { visitor, initial, timer });
    visitor.once("close", () => {
      if (hub.pending.get(id)?.visitor === visitor) {
        clearTimeout(timer);
        hub.pending.delete(id);
      }
    });
    hub.ws.send(JSON.stringify({ t: "open", stream: id, kind, visitor: plain(visitor.remoteAddress) }));
  };

  /** Reads the first bytes of a connection without consuming them for anyone else. */
  const readHead = (socket: net.Socket, parse: (buf: Buffer) => "more" | "done" | "bad", done: (buf: Buffer) => void) => {
    let buf = Buffer.alloc(0);
    socket.setTimeout(limits.helloMs, () => socket.destroy());
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const r = buf.length > MAX_HELLO_BYTES ? "bad" : parse(buf);
      if (r === "more") return;
      socket.off("data", onData);
      socket.pause();
      socket.setTimeout(0);
      if (r === "bad") socket.destroy();
      else done(buf);
    };
    socket.on("data", onData);
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let ownTls = { cert: opts.tls.cert, key: opts.tls.key };

  const authorized = (req: IncomingMessage, address: string): string | undefined => {
    const f = failures.get(address);
    if (f && f.until > Date.now()) return undefined;
    const name = String(req.headers["x-loom-hub"] ?? "");
    const secret = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (opts.registry.verify(name, secret)) {
      failures.delete(address);
      return name;
    }
    const count = (f?.count ?? 0) + 1;
    failures.set(address, { count, until: count >= limits.authFailures ? Date.now() + 10 * 60_000 : 0 });
    return undefined;
  };

  /** The relay's own endpoints, on its own certificate: one server object per connection, which knows the address. */
  const ownServerFor = (address: string): HttpsServer => {
    const server = createHttpsServer({ cert: ownTls.cert, key: ownTls.key }, (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" }).end("Loom relay\n");
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => onOwnUpgrade(req, socket, head, address));
    server.on("tlsClientError", (_err, socket) => socket.destroy());
    return server;
  };

  const onOwnUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, address: string) => {
    const url = new URL(req.url ?? "/", `https://${domain}`);
    const name = authorized(req, address);
    if (!name) {
      // A hub removed while connected loses its control connection at its next stream.
      const claimed = String(req.headers["x-loom-hub"] ?? "");
      if (url.pathname.startsWith("/v1/stream/") && hubs.has(claimed) && !opts.registry.list().some((h) => h.name === claimed)) {
        hubs.get(claimed)?.ws.close(4001, "this hub was removed from the relay");
      }
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname === "/v1/hub") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        hubs.get(name)?.ws.close(4000, "replaced by a newer connection");
        const link: HubLink = { name, ws, pending: new Map(), active: 0, missedPongs: 0, ping: setInterval(() => {
          if (link.missedPongs >= 2) return ws.terminate();
          link.missedPongs++;
          ws.ping();
        }, limits.pingMs) };
        ws.on("pong", () => (link.missedPongs = 0));
        hubs.set(name, link);
        log(`hub ${name} connected from ${address}`);
        ws.send(JSON.stringify({ t: "welcome", hostname: `${name}.${domain}` }));
        ws.on("message", () => undefined);
        ws.on("close", () => {
          clearInterval(link.ping);
          if (hubs.get(name) === link) hubs.delete(name);
          for (const p of link.pending.values()) {
            clearTimeout(p.timer);
            p.visitor.destroy();
          }
          link.pending.clear();
          log(`hub ${name} disconnected`);
        });
      });
      return;
    }
    const stream = /^\/v1\/stream\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
    const hub = hubs.get(name);
    const pending = stream ? hub?.pending.get(stream) : undefined;
    if (!hub || !stream || !pending) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    hub.pending.delete(stream);
    clearTimeout(pending.timer);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: loom-stream\r\n\r\n");
    socket.write(pending.initial);
    if (head.length) pending.visitor.write(head);
    hub.active++;
    const visitor = pending.visitor;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      hub.active--;
      visitor.destroy();
      socket.destroy();
    };
    for (const s of [visitor, socket]) {
      (s as net.Socket).setTimeout?.(limits.idleMs, finish);
      s.once("close", finish);
      s.on("error", finish);
    }
    // Plain pipes both ways: two opposite pipeline() calls add end-of-stream listeners to each socket twice.
    visitor.pipe(socket);
    socket.pipe(visitor);
    visitor.resume();
  };

  // Public TLS: route on the server name.
  const publicServer = net.createServer((socket) => {
    if (!track(socket)) return;
    readHead(
      socket,
      (buf) => {
        const r = parseClientHello(buf);
        return r.kind === "need-more" ? "more" : r.kind === "not-tls" ? "bad" : "done";
      },
      (buf) => {
        const r = parseClientHello(buf);
        const serverName = r.kind === "hello" ? r.serverName : undefined;
        if (serverName === domain) {
          ownServerFor(plain(socket.remoteAddress)).emit("connection", withPrefix(socket, buf));
          return;
        }
        const name = serverName ? hubNameFor(serverName) : undefined;
        if (!name) return socket.destroy();
        openStream(name, "tls", socket, buf);
      },
    );
  });

  // Plain HTTP: ACME challenges for hub names, redirects for everything else.
  const httpServer =
    opts.httpPort === undefined
      ? undefined
      : net.createServer((socket) => {
          if (!track(socket)) return;
          readHead(
            socket,
            (buf) => {
              const r = parseHttpHead(buf);
              return r.kind === "need-more" ? "more" : r.kind === "bad" ? "bad" : "done";
            },
            (buf) => {
              const r = parseHttpHead(buf);
              if (r.kind !== "request") return socket.destroy();
              const name = hubNameFor(r.host);
              if (name && r.path.startsWith("/.well-known/acme-challenge/") && hubs.has(name)) {
                openStream(name, "http", socket, buf);
                return;
              }
              if (name || r.host === domain) {
                const location = `https://${r.host}${r.path.startsWith("/") ? r.path : "/"}`;
                socket.end(`HTTP/1.1 301 Moved Permanently\r\nLocation: ${location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
              } else {
                socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
              }
            },
          );
        });

  const listen = (server: net.Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, opts.host, () => {
        server.off("error", reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });

  const httpsPort = await listen(publicServer, opts.httpsPort);
  const httpPort = httpServer ? await listen(httpServer, opts.httpPort!) : undefined;
  log(`relay for ${domain} on ${opts.host}:${httpsPort}${httpPort ? ` and :${httpPort}` : ""}`);

  return {
    httpsPort,
    httpPort,
    connectedHubs: () => [...hubs.keys()],
    setCertificate: (tls) => {
      ownTls = { cert: tls.cert, key: tls.key };
    },
    close: async () => {
      for (const hub of hubs.values()) hub.ws.terminate();
      for (const s of sockets) s.destroy();
      await Promise.all([publicServer, httpServer].filter((s): s is net.Server => s !== undefined).map((s) => new Promise<void>((r) => s.close(() => r()))));
      wss.close();
    },
  };
}

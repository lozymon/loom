import {
  type ClientFrame,
  type HubEvent,
  type HubFrame,
  parseClientFrame,
  PROTOCOL_VERSION,
  type Welcome,
} from "@loom/protocol";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "../auth.ts";
import type { SessionManager } from "../core/sessionManager.ts";
import type { BoardService } from "../board/boardService.ts";
import { HubError } from "../errors.ts";
import { route } from "./router.ts";
import { type Actor, HUMAN } from "../control/actor.ts";
import { LoginLimiter } from "../remote/loginLimiter.ts";
import type { VoiceService } from "../voice/voiceService.ts";
import { clientAddress, isForwarded, isLoopback } from "../remote/network.ts";
import { createServer as createTlsServer } from "node:https";
import type { PushService } from "../push/pushService.ts";
import { serveStatic } from "./static.ts";

export const WS_PATH = "/ws";

/** Close codes a client can show to a person. */
export const CloseCode = {
  unauthorized: 4001,
  protocolMismatch: 4002,
  badFrame: 4003,
  tooSlow: 4004,
  helloTimeout: 4005,
  shuttingDown: 1001,
} as const;

export interface HubServerOptions {
  manager: SessionManager;
  boards?: BoardService;
  voice?: VoiceService;
  push?: PushService;
  /** Connections arriving through the relay (ADR-0014): their TLS context and ACME answers. */
  relay?: { context(): import("node:tls").SecureContext | undefined; challenge(token: string): string | undefined };
  /** Certificate, and the hosts that use it. Loopback listeners stay plain HTTP for local tools. */
  tls?: { cert: Buffer; key: Buffer; hosts: string[] };
  hub: Welcome["hub"];
  tokenHash: string;
  /** More accepted token hashes for this run only, e.g. the desktop app's sign-in token. */
  extraTokenHashes?: string[];
  /** Addresses to listen on, all on the same port. The first one decides the port when it is 0. */
  hosts: string[];
  limiter?: LoginLimiter;
  port: number;
  /** Built client to serve at `/`. Optional; the dev client runs on Vite instead. */
  staticDir?: string;
  /** Close a client whose unsent data passes this many bytes. */
  maxBufferedBytes?: number;
  helloTimeoutMs?: number;
}

export interface HubServer {
  port: number;
  /** Serves a visitor connection that came through the relay. */
  acceptRelayStream(kind: "tls" | "http", socket: import("node:stream").Duplex, visitor: string): void;
  close(): Promise<void>;
}

interface Subscription {
  sessionIds?: Set<string>;
}

export async function startHubServer(opts: HubServerOptions): Promise<HubServer> {
  const maxBuffered = opts.maxBufferedBytes ?? 8 * 1024 * 1024;
  const helloTimeout = opts.helloTimeoutMs ?? 10_000;
  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : undefined;
  const connections = new Set<Connection>();
  const limiter = opts.limiter ?? new LoginLimiter();
  const stopBoards = opts.boards?.onChange((board) => {
    for (const c of connections) c.boardChanged(board);
  });

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://hub").pathname;
    if (relayVisitor(req) !== undefined && pathname.startsWith("/hooks/")) {
      res.writeHead(403).end();
      return;
    }
    if (pathname === "/loom.json") {
      // Unauthenticated and deliberately bare: lets `loom tunnel` and clients tell a Loom hub from another server.
      const text = JSON.stringify({ loom: "hub", protocol: PROTOCOL_VERSION });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(text);
      return;
    }
    const hookMatch = /^\/hooks\/([^/?]+)$/.exec(pathname);
    if (hookMatch) {
      void handleHook(opts.manager, decodeURIComponent(hookMatch[1]!), req, res);
      return;
    }
    if (staticDir && serveStatic(staticDir, req, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      staticDir
        ? "The Loom client is not built. Run `npm run build -w @loom/client`, or use `npm run client` for development.\n"
        : "Loom hub. Connect a client over WebSocket at /ws.\n",
    );
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const onUpgrade = (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://hub").pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Connection(ws, opts, maxBuffered, limiter, relayVisitor(req) ?? clientAddress(req.socket.remoteAddress, req.headers));
      connections.add(conn);
      const timer = setTimeout(() => {
        if (!conn.authed) ws.close(CloseCode.helloTimeout, "no hello received");
      }, helloTimeout);
      ws.on("close", () => {
        clearTimeout(timer);
        conn.dispose();
        connections.delete(conn);
      });
    });
  };

  // Relay streams: TLS terminated here with the relay certificate, or plain HTTP for ACME challenges only.
  // Each stream gets its own server object, so its requests can be tagged with the visitor's address.
  const relayTlsFor = (visitor: string) => {
    const server = createTlsServer({
      SNICallback: (_name, cb) => {
        const ctx = opts.relay?.context();
        if (ctx) cb(null, ctx);
        else cb(new Error("no relay certificate yet"));
      },
    });
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      relayVisitors.set(req, visitor);
      handler(req, res);
    });
    server.on("upgrade", (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
      relayVisitors.set(req, visitor);
      onUpgrade(req, socket, head);
    });
    server.on("tlsClientError", (_err, socket) => socket.destroy());
    return server;
  };
  const acmeHttp = createServer((req, res) => {
    const token = /^\/\.well-known\/acme-challenge\/([\w-]+)$/.exec(new URL(req.url ?? "/", "http://hub").pathname)?.[1];
    const answer = token ? opts.relay?.challenge(token) : undefined;
    if (answer) res.writeHead(200, { "content-type": "text/plain" }).end(answer);
    else res.writeHead(404).end();
  });

  const servers: Server[] = [];
  let port = opts.port;
  try {
    for (const host of opts.hosts) {
      const http = opts.tls?.hosts.includes(host) ? createTlsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : createServer(handler);
      http.on("upgrade", onUpgrade);
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolve();
        });
      });
      servers.push(http);
      port = (http.address() as AddressInfo).port;
    }
  } catch (err) {
    for (const s of servers) s.close();
    throw err;
  }

  return {
    port,
    acceptRelayStream: (kind, socket, visitor) => {
      socket.on("error", () => socket.destroy());
      (kind === "tls" ? relayTlsFor(visitor) : acmeHttp).emit("connection", socket);
    },
    close: async () => {
      stopBoards?.();
      for (const c of connections) c.ws.close(CloseCode.shuttingDown, "hub shutting down");
      wss.close();
      await Promise.all(servers.map((http) => new Promise<void>((resolve) => http.close(() => resolve()))));
    },
  };
}

class Connection {
  readonly ws: WebSocket;
  authed = false;
  actor: Actor = HUMAN;
  #opts: HubServerOptions;
  #maxBuffered: number;
  #subscription: Subscription | undefined;
  #unsubscribe: (() => void) | undefined;
  #terminals = new Map<string, () => void>();
  #boards = new Set<string>();

  #limiter: LoginLimiter;
  #address: string;

  constructor(ws: WebSocket, opts: HubServerOptions, maxBuffered: number, limiter: LoginLimiter, address: string) {
    this.ws = ws;
    this.#opts = opts;
    this.#maxBuffered = maxBuffered;
    this.#limiter = limiter;
    this.#address = address;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(CloseCode.badFrame, "binary frames are not supported");
        return;
      }
      void this.#onMessage(data.toString());
    });
  }

  boardChanged(board: import("@loom/protocol").BoardView): void {
    if (this.authed && this.#boards.has(board.root)) this.#send({ t: "board", board });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const detach of this.#terminals.values()) detach();
    this.#terminals.clear();
  }

  async #onMessage(raw: string): Promise<void> {
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      const id = requestIdOf(raw);
      if (id === undefined || !this.authed) {
        this.ws.close(CloseCode.badFrame, "invalid frame");
        return;
      }
      this.#send({ t: "res", id, ok: false, error: { code: "bad-frame", message: parsed.error } });
      return;
    }
    const frame: ClientFrame = parsed.value;

    if (frame.t === "hello") {
      if (this.authed) {
        this.ws.close(CloseCode.badFrame, "hello sent twice");
        return;
      }
      if (frame.protocol !== PROTOCOL_VERSION) {
        this.ws.close(CloseCode.protocolMismatch, `hub speaks protocol ${PROTOCOL_VERSION}, client ${frame.protocol}`);
        return;
      }
      const manager = this.#opts.manager;
      if (this.#limiter.isBlocked(this.#address)) {
        this.ws.close(CloseCode.unauthorized, "too many failed attempts; try again later");
        return;
      }
      const person = [this.#opts.tokenHash, ...(this.#opts.extraTokenHashes ?? [])].some((h) => verifyToken(frame.token, h));
      const session = person ? undefined : manager.tokens.verify(frame.token);
      if (!session && !person) {
        this.#limiter.fail(this.#address);
        this.ws.close(CloseCode.unauthorized, "invalid token");
        return;
      }
      this.#limiter.succeed(this.#address);
      this.actor = session ? { kind: "session", sessionId: session.sessionId, role: session.role } : HUMAN;
      this.authed = true;
      const you = session
        ? { kind: "session" as const, sessionId: session.sessionId, name: manager.get(session.sessionId).name, role: session.role }
        : { kind: "human" as const };
      this.#send({ t: "welcome", protocol: PROTOCOL_VERSION, hub: this.#opts.hub, headSeq: manager.head(), you });
      return;
    }

    if (!this.authed) {
      this.ws.close(CloseCode.unauthorized, "send hello first");
      return;
    }

    try {
      const data = await route(frame.body, {
        manager: this.#opts.manager,
        actor: this.actor,
        subscribe: (since, sessionIds) => this.#subscribe(since, sessionIds),
        attachTerminal: (sessionId) => this.#attachTerminal(sessionId),
        detachTerminal: (sessionId) => this.#detachTerminal(sessionId),
        boards: this.#opts.boards,
        watchBoard: (root) => this.#boards.add(root),
        voice: this.#opts.voice,
        push: this.#opts.push,
      });
      this.#send({ t: "res", id: frame.id, ok: true, ...(data !== undefined ? { data } : {}) });
    } catch (err) {
      const error =
        err instanceof HubError
          ? { code: err.code, message: err.message }
          : { code: "internal" as const, message: err instanceof Error ? err.message : String(err) };
      if (!(err instanceof HubError)) console.error("command failed:", frame.body.cmd, err);
      this.#send({ t: "res", id: frame.id, ok: false, error });
    }
  }

  /**
   * Replays events after `since`, then streams live ones. Replay and registration happen in one
   * synchronous step, so no event can fall between them.
   */
  #subscribe(since: number, sessionIds: string[] | undefined): number {
    this.dispose();
    const manager = this.#opts.manager;
    this.#subscription = sessionIds?.length ? { sessionIds: new Set(sessionIds) } : {};
    let cursor = since;
    for (;;) {
      const page = managerLog(manager, cursor, sessionIds);
      for (const e of page) this.#sendEvent(e);
      if (page.length < REPLAY_PAGE) break;
      cursor = page[page.length - 1]!.seq;
    }
    this.#unsubscribe = manager.subscribe((e) => this.#sendEvent(e));
    return manager.head();
  }

  /** Snapshot and live stream for one terminal on this connection. Re-attaching replaces the old stream. */
  #attachTerminal(sessionId: string): { offset: number; data: string; live: boolean } {
    this.#detachTerminal(sessionId);
    const attached = this.#opts.manager.terminalAttach(sessionId, (offset, bytes) =>
      this.#send({ t: "term", sessionId, offset, data: bytes.toString("base64") }),
    );
    this.#terminals.set(sessionId, attached.detach);
    return { offset: attached.offset, data: attached.data.toString("base64"), live: attached.live };
  }

  #detachTerminal(sessionId: string): void {
    this.#terminals.get(sessionId)?.();
    this.#terminals.delete(sessionId);
  }

  #sendEvent(e: HubEvent): void {
    const filter = this.#subscription?.sessionIds;
    if (filter && !filter.has(e.sessionId)) return;
    this.#send({ t: "evt", e });
  }

  #send(frame: HubFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.#maxBuffered) {
      this.ws.close(CloseCode.tooSlow, "client is not keeping up");
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }
}

const REPLAY_PAGE = 1000;
/** Visitor addresses reported by the relay, by request. */
const relayVisitors = new WeakMap<IncomingMessage, string>();

/** The visitor address for a request that came through the relay, else undefined. */
function relayVisitor(req: IncomingMessage): string | undefined {
  return relayVisitors.get(req);
}

const HOOK_BODY_MAX = 1024 * 1024;

/**
 * POST /hooks/<session>: an engine integration callback, e.g. a Claude Code HTTP hook. The request
 * stays open while a decision is pending; if the engine gives up and closes it, the pending approval
 * is cancelled. Errors are plain non-2xx responses, which Claude Code treats as non-blocking.
 */
async function handleHook(manager: SessionManager, sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body?: object) => {
    if (res.writableEnded) return;
    if (body === undefined) {
      res.writeHead(status, { "content-length": "0" });
      res.end();
    } else {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    }
  };
  if (req.method !== "POST") return reply(405);
  // Engines run on the hub's own machine; a hook never needs to arrive over the network.
  if (!isLoopback(req.socket.remoteAddress ?? "") || isForwarded(req.headers)) return reply(403);

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > HOOK_BODY_MAX) return reply(413);
      chunks.push(chunk);
    }
  } catch {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply(400);
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];

  try {
    const body = await manager.hook(sessionId, token, payload, abort.signal);
    reply(200, body);
  } catch (err) {
    const status = (err as { status?: number }).status ?? (err instanceof HubError && err.code === "not-found" ? 404 : 500);
    if (status === 500) console.error("hook failed:", err);
    reply(status);
  }
}

function managerLog(manager: SessionManager, since: number, sessionIds: string[] | undefined): HubEvent[] {
  return manager.replay(since, sessionIds, REPLAY_PAGE);
}

function requestIdOf(raw: string): number | undefined {
  try {
    const id = (JSON.parse(raw) as { id?: unknown }).id;
    return typeof id === "number" && Number.isInteger(id) && id >= 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

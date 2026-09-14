import {
  type BoardView,
  type CommandName,
  type CommandOf,
  type CommandResults,
  type HubEvent,
  parseHubFrame,
  type TermFrame,
  PROTOCOL_VERSION,
  type Welcome,
} from "@loom/protocol";

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "open"; welcome: Welcome }
  | { kind: "retrying"; inMs: number; reason: string }
  /** Terminal: the hub refused us. Retrying will not help until something changes. */
  | { kind: "refused"; reason: string };

export interface ConnectionHandlers {
  onOpen(welcome: Welcome): void;
  onEvent(event: HubEvent): void;
  onTerm(frame: TermFrame): void;
  onBoard(board: BoardView): void;
  onStatus(status: ConnectionStatus): void;
}

export class RequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

/** Close codes that mean "do not retry" (mirrors CloseCode in the hub). */
const REFUSED: Record<number, string> = {
  4001: "The hub rejected the access token.",
  4002: "This client and the hub speak different protocol versions.",
};

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
}

/**
 * One WebSocket to one hub: hello, request/response matching, event delivery, and reconnect with
 * backoff. Knows nothing about sessions; the store builds state from what this delivers.
 */
export class HubConnection {
  readonly url: string;
  #token: string;
  #handlers: ConnectionHandlers;
  #ws: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closedByUs = false;

  constructor(url: string, token: string, handlers: ConnectionHandlers) {
    this.url = url;
    this.#token = token;
    this.#handlers = handlers;
  }

  connect(): void {
    this.#closedByUs = false;
    this.#handlers.onStatus({ kind: "connecting" });
    const ws = new WebSocket(this.url);
    this.#ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind: "web", version: "0.0.0" }, token: this.#token }),
      );
    };

    ws.onmessage = (msg) => {
      const parsed = parseHubFrame(String(msg.data));
      if (!parsed.ok) {
        console.error("bad frame from hub", parsed.error);
        return;
      }
      const frame = parsed.value;
      if (frame.t === "welcome") {
        this.#attempt = 0;
        this.#handlers.onStatus({ kind: "open", welcome: frame });
        this.#handlers.onOpen(frame);
      } else if (frame.t === "evt") {
        this.#handlers.onEvent(frame.e);
      } else if (frame.t === "term") {
        this.#handlers.onTerm(frame);
      } else if (frame.t === "board") {
        this.#handlers.onBoard(frame.board);
      } else {
        const p = this.#pending.get(frame.id);
        if (!p) return;
        this.#pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(new RequestError(frame.error.code, frame.error.message));
      }
    };

    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      for (const p of this.#pending.values()) p.reject(new RequestError("disconnected", "connection to the hub closed"));
      this.#pending.clear();
      if (this.#closedByUs) return;

      const refused = REFUSED[ev.code];
      if (refused) {
        this.#handlers.onStatus({ kind: "refused", reason: ev.reason ? `${refused} (${ev.reason})` : refused });
        return;
      }
      const inMs = Math.min(5000, 500 * 2 ** this.#attempt++);
      this.#handlers.onStatus({ kind: "retrying", inMs, reason: ev.reason || "connection lost" });
      this.#timer = setTimeout(() => this.connect(), inMs);
    };
  }

  request<N extends CommandName>(body: CommandOf<N>): Promise<CommandResults[N]> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RequestError("disconnected", "not connected to the hub"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
      ws.send(JSON.stringify({ t: "req", id, body }));
    });
  }

  close(): void {
    this.#closedByUs = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000, "client closed");
    this.#ws = undefined;
  }
}


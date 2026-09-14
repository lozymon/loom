import { type CommandName, type CommandOf, type CommandResults, parseHubFrame, PROTOCOL_VERSION, type Welcome } from "@loom/protocol";
import { WebSocket } from "ws";
import type { LoomApi } from "../core/adapter.ts";

/** A small WebSocket client for the `loom` CLI and the stdio MCP server. */
export class HubClient implements LoomApi {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  welcome!: Welcome;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  static connect(url: string, token: string, kind: "cli" | "mcp"): Promise<HubClient> {
    const wsUrl = url.replace(/^http/, "ws").replace(/\/?$/, "/ws");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const client = new HubClient(ws);
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, client: { kind, version: "0.0.0" }, token })));
      ws.on("error", (err) => reject(new Error(`cannot reach the Loom hub at ${url}: ${err.message}`)));
      ws.on("close", (code, reason) => {
        const err = new Error(`the Loom hub closed the connection (${code}${reason.length ? `: ${reason}` : ""})`);
        for (const p of client.#pending.values()) p.reject(err);
        client.#pending.clear();
        reject(err);
      });
      ws.on("message", (data) => {
        const parsed = parseHubFrame(data.toString());
        if (!parsed.ok) return;
        const f = parsed.value;
        if (f.t === "welcome") {
          client.welcome = f;
          resolve(client);
        } else if (f.t === "res") {
          const p = client.#pending.get(f.id);
          if (!p) return;
          client.#pending.delete(f.id);
          if (f.ok) p.resolve(f.data);
          else p.reject(new Error(f.error.message));
        }
      });
    });
  }

  request<N extends CommandName>(cmd: CommandOf<N>): Promise<CommandResults[N]> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ t: "req", id, body: cmd }));
    });
  }

  close(): void {
    this.#ws.close();
  }
}

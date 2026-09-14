import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { SidecarCommand, SidecarEvent } from "./sidecarProtocol.ts";

export interface TerminalHandlers {
  output(bytes: Buffer): void;
  /** `code` is -1 when the sidecar itself died; `reason` says why. */
  exit(code: number, reason?: string): void;
}

export interface SpawnRequest {
  program: string;
  args: string[];
  cwd?: string | undefined;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

interface Pending {
  resolve(pid: number | null): void;
  reject(err: Error): void;
  handlers: TerminalHandlers;
}

/**
 * The hub's handle on one loom-pty process, which serves every terminal on the hub (ADR-0002).
 * Spawning the sidecar with a clean environment matters: terminals inherit the sidecar's.
 */
export class PtySidecar {
  readonly version: string;
  #child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #live = new Map<number, TerminalHandlers>();
  #dead = false;
  #onDeath = new Set<(reason: string) => void>();

  private constructor(child: ChildProcessWithoutNullStreams, version: string) {
    this.#child = child;
    this.version = version;
  }

  static start(binary: string, env: Record<string, string>, timeoutMs = 5000): Promise<PtySidecar> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let sidecar: PtySidecar | undefined;
      const stderr: string[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`terminal sidecar did not start within ${timeoutMs} ms`));
      }, timeoutMs);

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderr.push(d);
        if (stderr.length > 20) stderr.shift();
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        if (sidecar) sidecar.#die(`terminal sidecar failed: ${err.message}`);
        else reject(new Error(`could not start terminal sidecar ${binary}: ${err.message}`));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        const why = `terminal sidecar exited (${signal ?? code})${stderr.length ? `: ${stderr.join("").trim()}` : ""}`;
        if (sidecar) sidecar.#die(why);
        else reject(new Error(why));
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let event: SidecarEvent;
        try {
          event = JSON.parse(line) as SidecarEvent;
        } catch {
          console.error("terminal sidecar sent a bad line:", line.slice(0, 200));
          return;
        }
        if (!sidecar) {
          if (event.ev === "ready") {
            clearTimeout(timer);
            sidecar = new PtySidecar(child, event.version);
            resolve(sidecar);
          }
          return;
        }
        sidecar.#onEvent(event);
      });
    });
  }

  get alive(): boolean {
    return !this.#dead;
  }

  /** Called once if the sidecar process dies. Every live terminal has already been told it exited. */
  onDeath(listener: (reason: string) => void): () => void {
    this.#onDeath.add(listener);
    return () => this.#onDeath.delete(listener);
  }

  spawn(req: SpawnRequest, handlers: TerminalHandlers): Promise<{ id: number; pid: number | null }> {
    if (this.#dead) return Promise.reject(new Error("terminal sidecar is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: (pid) => resolve({ id, pid }), reject, handlers });
      const { cwd, ...rest } = req;
      this.#send({ op: "spawn", id, ...rest, ...(cwd === undefined ? {} : { cwd }) });
    });
  }

  write(id: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#send({ op: "write", id, data: Buffer.from(bytes).toString("base64") });
  }

  resize(id: number, cols: number, rows: number): void {
    this.#send({ op: "resize", id, cols, rows });
  }

  kill(id: number): void {
    this.#send({ op: "kill", id });
  }

  /** Closing stdin makes the sidecar kill every terminal and exit. */
  close(): void {
    if (this.#dead) return;
    this.#child.stdin.end();
  }

  #send(cmd: SidecarCommand): void {
    if (this.#dead || !this.#child.stdin.writable) return;
    this.#child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  #onEvent(event: SidecarEvent): void {
    switch (event.ev) {
      case "spawned": {
        const p = this.#pending.get(event.id);
        if (!p) return;
        this.#pending.delete(event.id);
        this.#live.set(event.id, p.handlers);
        p.resolve(event.pid);
        return;
      }
      case "output":
        this.#live.get(event.id)?.output(Buffer.from(event.data, "base64"));
        return;
      case "exit": {
        const h = this.#live.get(event.id);
        this.#live.delete(event.id);
        h?.exit(event.code);
        return;
      }
      case "error": {
        const p = event.id !== undefined ? this.#pending.get(event.id) : undefined;
        if (p && event.id !== undefined) {
          this.#pending.delete(event.id);
          p.reject(new Error(event.message));
        } else if (!/no running terminal|has exited/.test(event.message)) {
          console.error("terminal sidecar:", event.message);
        }
        return;
      }
      case "ready":
        return;
    }
  }

  #die(reason: string): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const p of this.#pending.values()) p.reject(new Error(reason));
    this.#pending.clear();
    for (const h of this.#live.values()) h.exit(-1, reason);
    this.#live.clear();
    for (const l of this.#onDeath) l(reason);
  }
}

/** Starts the sidecar on first use and again after it dies. */
export class SidecarProvider {
  #binary: () => string | undefined;
  #env: () => Record<string, string>;
  #current: Promise<PtySidecar> | undefined;

  constructor(binary: () => string | undefined, env: () => Record<string, string>) {
    this.#binary = binary;
    this.#env = env;
  }

  get(): Promise<PtySidecar> {
    if (!this.#current) {
      const binary = this.#binary();
      if (!binary) {
        return Promise.reject(new Error("the terminal sidecar is not built. Run `npm run build:pty`, or set LOOM_PTY_BIN."));
      }
      const starting = PtySidecar.start(binary, this.#env());
      this.#current = starting;
      starting.then(
        (s) => s.onDeath(() => { if (this.#current === starting) this.#current = undefined; }),
        () => { if (this.#current === starting) this.#current = undefined; },
      );
    }
    return this.#current;
  }

  async close(): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    if (current) (await current.catch(() => undefined))?.close();
  }
}

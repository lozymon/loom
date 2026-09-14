import type { SpokenLanguage } from "@loom/protocol";
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { HubError } from "../errors.ts";

export interface Transcript {
  text: string;
  language: SpokenLanguage;
  audioMs: number;
  tookMs: number;
}

interface Pending {
  resolve(t: Transcript): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

type VoceLine =
  | { ev: "ready"; model: string; multilingual: boolean; gpu: boolean }
  | { ev: "transcript"; id: number; text: string; language: string; audioMs: number; tookMs: number }
  | { ev: "error"; id?: number; message: string };

export interface WhisperOptions {
  binary: string;
  model: string;
  threads?: number | undefined;
  /** Stop the sidecar after this long without work, to give its memory back. */
  idleMs?: number;
  requestTimeoutMs?: number;
  spawn?: (binary: string, args: string[]) => ChildProcess;
}

/**
 * The loom-voce sidecar (ADR-0009). Started on the first clip, since loading a model takes seconds and
 * hundreds of megabytes, and stopped again when idle. Clips are answered in order.
 */
export class WhisperSidecar {
  #opts: WhisperOptions;
  #child: ChildProcess | undefined;
  #ready: Promise<void> | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #idle: NodeJS.Timeout | undefined;

  constructor(opts: WhisperOptions) {
    this.#opts = opts;
  }

  get running(): boolean {
    return this.#child !== undefined;
  }

  async transcribe(pcm: Buffer, language?: SpokenLanguage, prompt?: string): Promise<Transcript> {
    clearTimeout(this.#idle);
    await this.#start();
    const child = this.#child;
    if (!child?.stdin) throw new HubError("engine", "the speech sidecar is not running");
    const id = this.#nextId++;
    return new Promise<Transcript>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HubError("engine", "speech recognition took too long"));
      }, this.#opts.requestTimeoutMs ?? 5 * 60_000);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${JSON.stringify({ op: "transcribe", id, pcm: pcm.toString("base64"), ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) })}\n`);
    }).finally(() => this.#armIdle());
  }

  #armIdle(): void {
    clearTimeout(this.#idle);
    if (this.#pending.size > 0) return;
    this.#idle = setTimeout(() => this.close(), this.#opts.idleMs ?? 10 * 60_000);
    this.#idle.unref();
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const args = ["--model", this.#opts.model, ...(this.#opts.threads ? ["--threads", String(this.#opts.threads)] : [])];
    const child = (this.#opts.spawn ?? ((bin, a) => spawn(bin, a, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })))(this.#opts.binary, args);
    this.#child = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-2000);
    });

    this.#ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let msg: VoceLine;
        try {
          msg = JSON.parse(line) as VoceLine;
        } catch {
          return;
        }
        if (msg.ev === "ready") resolve();
        else if (msg.ev === "transcript") {
          this.#settle(msg.id, undefined, {
            text: msg.text,
            language: msg.language === "pt" ? "pt" : "en",
            audioMs: msg.audioMs,
            tookMs: msg.tookMs,
          });
        } else if (msg.id !== undefined) this.#settle(msg.id, new HubError("engine", msg.message));
        else reject(new HubError("engine", msg.message));
      });
      const gone = (reason: string) => {
        const err = new HubError("engine", `the speech sidecar stopped: ${reason}${stderr.trim() ? ` (${stderr.trim().split("\n").at(-1)})` : ""}`);
        reject(err);
        for (const id of [...this.#pending.keys()]) this.#settle(id, err);
        if (this.#child === child) {
          this.#child = undefined;
          this.#ready = undefined;
        }
      };
      child.once("error", (err) => gone(err.message));
      child.once("exit", (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code}`));
    });
    return this.#ready;
  }

  #settle(id: number, err: Error | undefined, value?: Transcript): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value!);
  }

  close(): void {
    clearTimeout(this.#idle);
    const child = this.#child;
    this.#child = undefined;
    this.#ready = undefined;
    child?.stdin?.end();
    child?.kill();
  }
}

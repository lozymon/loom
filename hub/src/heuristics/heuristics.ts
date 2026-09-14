import type { SessionEvent, SessionSummary } from "@loom/protocol";
import type { TerminalBuffer } from "../core/terminalBuffer.ts";
import { type LoadedManifest, manifestFor } from "./manifest.ts";
import { ScreenWatcher, type ScreenState } from "./screenWatcher.ts";

interface Tracked {
  watcher: ScreenWatcher;
  detach: () => void;
}

export interface HeuristicsOptions {
  manifests: readonly LoadedManifest[];
  /** How often queued output is rendered and matched. */
  tickMs?: number;
  summary(id: string): SessionSummary | undefined;
  emit(id: string, event: Extract<SessionEvent, { type: "session.state" }>): void;
}

/**
 * Heuristic state for terminal sessions whose program has an enabled manifest (ADR-0011). A session
 * that ever reports state by itself (hooks, provenance `pushed`) is left alone.
 */
export class Heuristics {
  #opts: HeuristicsOptions;
  #tracked = new Map<string, Tracked>();
  #pushed = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(opts: HeuristicsOptions) {
    this.#opts = opts;
  }

  get enabled(): boolean {
    return this.#opts.manifests.length > 0;
  }

  /** Watches a terminal session if a manifest applies to its program. Returns the manifest id, if any. */
  track(id: string, program: { agent?: string | undefined; command?: string | undefined }, buffer: TerminalBuffer, size: { cols: number; rows: number }): string | undefined {
    if (this.#tracked.has(id) || this.#pushed.has(id)) return this.#tracked.get(id)?.watcher.loaded.manifest.id;
    const loaded = manifestFor(this.#opts.manifests, program);
    if (!loaded) return undefined;
    const watcher = new ScreenWatcher(loaded, size.cols, size.rows);
    const { data, detach } = buffer.attach((_offset, bytes) => watcher.queue(bytes));
    if (data.length) watcher.queue(data);
    this.#tracked.set(id, { watcher, detach });
    this.#ensureTimer();
    return loaded.manifest.id;
  }

  /** A session reported its own state: heuristics step aside for good. */
  sawPushed(id: string): void {
    this.#pushed.add(id);
    this.untrack(id);
  }

  resize(id: string, cols: number, rows: number): void {
    this.#tracked.get(id)?.watcher.resize(cols, rows);
  }

  untrack(id: string): void {
    const t = this.#tracked.get(id);
    if (!t) return;
    t.detach();
    t.watcher.dispose();
    this.#tracked.delete(id);
    if (this.#tracked.size === 0) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #ensureTimer(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#opts.tickMs ?? 1000);
    this.#timer.unref();
  }

  /** Renders and matches every watched session once. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const [id, t] of [...this.#tracked]) {
        const found: ScreenState | undefined = await t.watcher.evaluate();
        const s = this.#opts.summary(id);
        if (!found || !s || !s.live || s.archived) continue;
        if (s.state === found.state && s.blockedOn === found.blockedOn) continue;
        this.#opts.emit(id, { type: "session.state", state: found.state, provenance: "heuristic", ...(found.blockedOn ? { blockedOn: found.blockedOn } : {}) });
      }
    } finally {
      this.#running = false;
    }
  }

  close(): void {
    for (const id of [...this.#tracked.keys()]) this.untrack(id);
  }
}

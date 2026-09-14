import type { BlockedOn } from "@loom/protocol";
import headless from "@xterm/headless";
import type { CompiledRule, LoadedManifest } from "./manifest.ts";

const { Terminal } = headless;

const MAX_PENDING_BYTES = 512 * 1024;

export interface ScreenState {
  state: "working" | "blocked" | "idle";
  blockedOn?: BlockedOn | undefined;
}

/** The last `n` non-empty lines of a screen, top to bottom. */
export function screenTail(lines: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i]!.replace(/\s+$/, "");
    if (line) out.unshift(line);
  }
  return out;
}

/** The first rule, in manifest order, with a pattern matching any tail line. */
export function matchRules(rules: readonly CompiledRule[], tail: readonly string[]): ScreenState | undefined {
  for (const rule of rules) {
    if (rule.patterns.some((re) => tail.some((line) => re.test(line)))) {
      return { state: rule.state, ...(rule.blockedOn ? { blockedOn: rule.blockedOn } : {}) };
    }
  }
  return undefined;
}

/**
 * A headless terminal for one session (ADR-0011): output is queued as it arrives (no parsing on the
 * output path) and rendered and matched at most once per tick.
 */
export class ScreenWatcher {
  readonly loaded: LoadedManifest;
  #term: InstanceType<typeof Terminal>;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #dirty = false;

  constructor(loaded: LoadedManifest, cols: number, rows: number) {
    this.loaded = loaded;
    this.#term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  /** Called from the output path: only queues. */
  queue(bytes: Buffer): void {
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.length;
    this.#dirty = true;
    if (this.#pendingBytes > MAX_PENDING_BYTES) {
      // Far behind: keep the newest bytes; the screen will settle from them.
      const joined = Buffer.concat(this.#pending).subarray(-MAX_PENDING_BYTES / 2);
      this.#pending = [joined];
      this.#pendingBytes = joined.length;
    }
  }

  resize(cols: number, rows: number): void {
    this.#term.resize(cols, rows);
    this.#dirty = true;
  }

  /** Renders queued output and matches the manifest; undefined when nothing changed or nothing matched. */
  async evaluate(): Promise<ScreenState | undefined> {
    if (!this.#dirty) return undefined;
    this.#dirty = false;
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (data.length) await new Promise<void>((resolve) => this.#term.write(data, resolve));
    const buffer = this.#term.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.baseY; i < buffer.baseY + this.#term.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return matchRules(this.loaded.rules, screenTail(lines, this.loaded.manifest.tail_lines));
  }

  dispose(): void {
    this.#term.dispose();
  }
}

export type TerminalListener = (offset: number, bytes: Buffer) => void;

/**
 * The recent output of one terminal session, kept in memory so a client that attaches late or
 * reconnects sees the current screen (ADR-0003: terminal bytes never enter the event log).
 *
 * Offsets count every byte the session ever produced, across restarts, so a client can tell
 * exactly which bytes it already has.
 */
export class TerminalBuffer {
  readonly maxBytes: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #end = 0;
  #listeners = new Set<TerminalListener>();

  constructor(maxBytes = 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  /** Offset one past the last byte produced. */
  get end(): number {
    return this.#end;
  }

  append(bytes: Buffer): void {
    if (bytes.length === 0) return;
    const offset = this.#end;
    this.#chunks.push(bytes);
    this.#size += bytes.length;
    this.#end += bytes.length;
    this.#trim();
    for (const l of this.#listeners) l(offset, bytes);
  }

  /** The retained tail and the offset of its first byte. */
  snapshot(): { offset: number; data: Buffer } {
    const data = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#size);
    return { offset: this.#end - this.#size, data };
  }

  /** Snapshot and subscribe in one step, so no bytes fall between them. */
  attach(listener: TerminalListener): { offset: number; data: Buffer; detach: () => void } {
    const snap = this.snapshot();
    this.#listeners.add(listener);
    return { ...snap, detach: () => this.#listeners.delete(listener) };
  }

  #trim(): void {
    while (this.#size > this.maxBytes && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift()!.length;
    }
    if (this.#size > this.maxBytes) {
      const only = this.#chunks[0]!;
      this.#chunks[0] = only.subarray(only.length - this.maxBytes);
      this.#size = this.maxBytes;
    }
  }
}

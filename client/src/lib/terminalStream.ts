/**
 * Keeps a terminal view consistent with a byte stream that can overlap: the hub's snapshot and
 * live frames carry absolute offsets, and anything already shown is dropped.
 */
export class TerminalStream {
  #next = 0;
  #write: (bytes: Uint8Array) => void;
  #reset: () => void;

  constructor(write: (bytes: Uint8Array) => void, reset: () => void) {
    this.#write = write;
    this.#reset = reset;
  }

  get next(): number {
    return this.#next;
  }

  snapshot(offset: number, bytes: Uint8Array): void {
    this.#reset();
    this.#next = offset;
    this.data(offset, bytes);
  }

  /** Returns false when bytes are missing before `offset`, which means the view needs a new snapshot. */
  data(offset: number, bytes: Uint8Array): boolean {
    const end = offset + bytes.length;
    if (end <= this.#next) return true;
    if (offset > this.#next) {
      this.#write(bytes);
      this.#next = end;
      return false;
    }
    this.#write(offset === this.#next ? bytes : bytes.subarray(this.#next - offset));
    this.#next = end;
    return true;
  }
}

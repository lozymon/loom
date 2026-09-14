interface Record {
  failures: number[];
  blockedUntil: number;
}

/** Cuts off an address after repeated bad tokens (M7). */
export class LoginLimiter {
  #max: number;
  #windowMs: number;
  #blockMs: number;
  #now: () => number;
  #byAddress = new Map<string, Record>();

  constructor(opts: { max?: number; windowMs?: number; blockMs?: number; now?: () => number } = {}) {
    this.#max = opts.max ?? 10;
    this.#windowMs = opts.windowMs ?? 10 * 60_000;
    this.#blockMs = opts.blockMs ?? 10 * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  isBlocked(address: string): boolean {
    const r = this.#byAddress.get(address);
    return r !== undefined && r.blockedUntil > this.#now();
  }

  fail(address: string): void {
    const now = this.#now();
    const r = this.#byAddress.get(address) ?? { failures: [], blockedUntil: 0 };
    r.failures = r.failures.filter((t) => t > now - this.#windowMs);
    r.failures.push(now);
    if (r.failures.length >= this.#max) {
      r.blockedUntil = now + this.#blockMs;
      r.failures = [];
    }
    this.#byAddress.set(address, r);
  }

  succeed(address: string): void {
    this.#byAddress.delete(address);
  }
}

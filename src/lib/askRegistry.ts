// Ask/reply correlation registry — the state behind `loom ask` / `loom reply` (§2a). It turns the
// fire-and-forget bus into a request/response RPC: an agent asks another pane a question and blocks
// until that pane's agent answers, without Loom ever parsing pane output (ADR-0001) — the callee
// *pushes* its answer back over the bus (ADR-0007).
//
// Why a mailbox and not a held socket: the Rust relay caps each parked connection at ~10s (a fast-
// fail for a wedged frontend). An agent's answer can take far longer, and Rust is a pure relay so
// it can't special-case an `ask`. So `ask` returns a correlation id immediately; the `loom ask`
// CLI then long-polls `ask.await` in <10s slices until the reply arrives or the ask expires. This
// module is the correlation state (product logic → TS), keyed by a monotonic id.

/** State an `ask.await` poll can report back. */
export type AwaitState = "answered" | "pending" | "expired" | "unknown";

export interface AwaitResult {
  state: AwaitState;
  answer?: string;
  /** Display name of the pane that replied (if known). */
  by?: string;
}

interface AskEntry {
  target: string;
  from: string;
  question: string;
  /** Set once a reply lands; undefined while still open. */
  answer?: string;
  by?: string;
  /** Poll promises parked in `ask.await`, resolved by a reply or expiry. */
  waiters: Set<(r: AwaitResult) => void>;
  /** Auto-expiry timer so a dropped asker (CLI killed) can't leak an entry forever. */
  expiry: ReturnType<typeof setTimeout>;
}

let nextId = 0;
const asks = new Map<number, AskEntry>();

/** Register a new pending ask; returns its correlation id. Auto-expires after `timeoutMs`. */
export function createAsk(target: string, from: string, question: string, timeoutMs: number): number {
  const id = ++nextId;
  const expiry = setTimeout(() => expire(id), Math.max(1000, timeoutMs));
  asks.set(id, { target, from, question, waiters: new Set(), expiry });
  return id;
}

function expire(id: number) {
  const a = asks.get(id);
  if (!a) return;
  asks.delete(id);
  for (const w of a.waiters) w({ state: "expired" });
}

/** Long-poll for a reply to `id`, resolving early when one arrives, else `pending` after `waitMs`
 *  (kept under the relay's ~10s cap so the socket never times out mid-poll). */
export function awaitAsk(id: number, waitMs: number): Promise<AwaitResult> {
  const a = asks.get(id);
  if (!a) return Promise.resolve({ state: "unknown" });
  // A reply that arrived between polls (no waiter parked at the time) is sitting here — consume it.
  if (a.answer !== undefined) {
    asks.delete(id);
    clearTimeout(a.expiry);
    return Promise.resolve({ state: "answered", answer: a.answer, by: a.by });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: AwaitResult) => {
      if (settled) return;
      settled = true;
      a.waiters.delete(waiter);
      clearTimeout(pollTimer);
      resolve(r);
    };
    const waiter = (r: AwaitResult) => finish(r);
    a.waiters.add(waiter);
    const pollTimer = setTimeout(() => finish({ state: "pending" }), waitMs);
  });
}

/** Deliver a reply to ask `id`. Returns false if there's no open ask (expired, or already answered)
 *  so `loom reply` can tell the callee its answer went nowhere. If nobody is polling right now the
 *  answer is stashed on the entry for the next `ask.await` to pick up. */
export function replyAsk(id: number, answer: string, by?: string): boolean {
  const a = asks.get(id);
  if (!a || a.answer !== undefined) return false;
  a.answer = answer;
  a.by = by;
  if (a.waiters.size > 0) {
    // Hand the answer to the parked poll(s) and retire the entry — it's carried in the payload.
    const waiters = [...a.waiters];
    a.waiters.clear();
    asks.delete(id);
    clearTimeout(a.expiry);
    for (const w of waiters) w({ state: "answered", answer, by });
  }
  // else: leave the entry (answer stashed); the next awaitAsk() consumes and deletes it.
  return true;
}

/** Drop a pending ask immediately (e.g. the callee turned out not to be live). Resolves any
 *  parked polls as `unknown` and clears the expiry timer. */
export function cancelAsk(id: number) {
  const a = asks.get(id);
  if (!a) return;
  asks.delete(id);
  clearTimeout(a.expiry);
  for (const w of a.waiters) w({ state: "unknown" });
}

/** Test seam: how many asks are currently open. */
export function openAskCount(): number {
  return asks.size;
}

// Serialize PTY spawns so multiple agent panes never attach to their consoles at the same instant.
//
// On Windows, launching several `claude` panes concurrently (opening a fresh multi-agent workspace)
// makes all but the LAST one hang at startup — the most-recent console attach wins, so each new
// claude starves the earlier panes' stdin and they block before Node even spins up (0 CPU, 1
// thread, blank pane). Creating the PTYs one at a time — each child fully attaching and
// initializing before the next begins — makes every pane come up. The stagger delay after each
// spawn covers the child's async console-attach window (the spawn call returns before the child has
// finished grabbing its console).
//
// This is a global queue shared by every Terminal pane: they all mount at once on a workspace
// switch, so the serialization has to span the whole burst, not per-pane.

/** Tail of the serialized spawn chain. Each queued spawn waits on it, then extends it. */
let chain: Promise<unknown> = Promise.resolve();

/** Reset the queue — tests only, so cases don't leak the chain into one another. */
export function resetSpawnQueue(): void {
  chain = Promise.resolve();
}

/**
 * Run `spawn` only after every previously-queued spawn has finished and settled, so PTYs are
 * created strictly one at a time. Returns `spawn`'s result (its rejection propagates to the caller
 * unchanged); the internal chain swallows outcomes so one failed spawn never stalls the queue.
 *
 * `staggerMs` is the settle gap held after each spawn before the next may start — long enough for a
 * freshly-launched agent to attach to its console. `sleep` is injectable for tests.
 */
export function serializeSpawn<T>(
  spawn: () => Promise<T>,
  staggerMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  // Run `spawn` regardless of whether the prior link resolved or rejected.
  const run = chain.then(spawn, spawn);
  // Advance the chain to complete only after this spawn AND the settle delay — success or failure —
  // so the next queued spawn can't start until this child has had time to claim its console.
  chain = run.then(
    () => sleep(staggerMs),
    () => sleep(staggerMs),
  );
  return run;
}

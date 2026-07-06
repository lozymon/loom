import { describe, it, expect, beforeEach } from "vitest";
import { serializeSpawn, resetSpawnQueue } from "./spawnQueue";

beforeEach(() => resetSpawnQueue());

/** A no-op sleep so tests don't wait real time; still yields a microtask turn. */
const noSleep = () => Promise.resolve();

describe("serializeSpawn", () => {
  it("runs spawns strictly one at a time, in order, with no overlap", async () => {
    const events: string[] = [];
    let active = 0;

    // Each "spawn" records enter/exit and asserts it never overlaps another.
    const make = (name: string) => async () => {
      active++;
      expect(active).toBe(1); // never two spawns in flight at once
      events.push(`enter:${name}`);
      await Promise.resolve(); // simulate async work spanning a microtask
      events.push(`exit:${name}`);
      active--;
      return name;
    };

    // Queue three at once, as panes do when a workspace mounts.
    const results = await Promise.all([
      serializeSpawn(make("a"), 0, noSleep),
      serializeSpawn(make("b"), 0, noSleep),
      serializeSpawn(make("c"), 0, noSleep),
    ]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual([
      "enter:a", "exit:a",
      "enter:b", "exit:b",
      "enter:c", "exit:c",
    ]);
  });

  it("propagates a spawn's rejection to its caller but keeps the queue running", async () => {
    const ran: string[] = [];
    const ok = (name: string) => async () => { ran.push(name); return name; };
    const boom = async () => { ran.push("boom"); throw new Error("spawn failed"); };

    const first = serializeSpawn(ok("first"), 0, noSleep);
    const failed = serializeSpawn(boom, 0, noSleep);
    const after = serializeSpawn(ok("after"), 0, noSleep);

    await expect(first).resolves.toBe("first");
    await expect(failed).rejects.toThrow("spawn failed");
    // A failed spawn must not wedge the queue — the next one still runs.
    await expect(after).resolves.toBe("after");
    expect(ran).toEqual(["first", "boom", "after"]);
  });
});

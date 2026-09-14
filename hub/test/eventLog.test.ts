import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/log/eventLog.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("EventLog", () => {
  it("assigns increasing seq and reads back in order", () => {
    const log = new EventLog(":memory:", "h");
    const a = log.append("s1", { type: "cost.update", costUsd: 1 }, 10);
    const b = log.append("s2", { type: "cost.update", costUsd: 2 }, 11);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(log.head()).toBe(2);
    expect(log.readSince(0).map((e) => e.sessionId)).toEqual(["s1", "s2"]);
    expect(log.readSince(1).map((e) => e.seq)).toEqual([2]);
  });

  it("filters by session and limits", () => {
    const log = new EventLog(":memory:", "h");
    for (let i = 0; i < 5; i++) log.append(i % 2 ? "odd" : "even", { type: "cost.update", costUsd: i });
    expect(log.readSince(0, { sessionIds: ["odd"] }).map((e) => e.seq)).toEqual([2, 4]);
    expect(log.readSince(0, { limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("rejects invalid events", () => {
    const log = new EventLog(":memory:", "h");
    expect(() => log.append("s1", { type: "cost.update", costUsd: -1 })).toThrow();
    expect(log.head()).toBe(0);
  });

  it("persists across reopen and pages through forEach", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "loom-log-"));
    dirs.push(dir);
    const file = path.join(dir, "events.db");
    const first = new EventLog(file, "h");
    for (let i = 0; i < 7; i++) first.append("s1", { type: "cost.update", costUsd: i });
    first.close();

    const second = new EventLog(file, "h");
    expect(second.head()).toBe(7);
    const seen: number[] = [];
    second.forEach((e) => seen.push(e.seq), 3);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    second.close();
  });
});

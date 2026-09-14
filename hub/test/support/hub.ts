import type { HubEvent, PermissionLevel } from "@loom/protocol";
import { SessionManager } from "../../src/core/sessionManager.ts";
import { EventLog } from "../../src/log/eventLog.ts";
import { fakeFactory } from "./fakeAdapter.ts";

export function testHub(
  opts: { log?: EventLog; maxLevel?: PermissionLevel; defaultLevel?: PermissionLevel; failStart?: string } = {},
) {
  const log = opts.log ?? new EventLog(":memory:", "test-hub");
  const fake = fakeFactory(opts.failStart !== undefined ? { failStart: opts.failStart } : {});
  let clock = 1_000;
  let ids = 0;
  const manager = new SessionManager({
    log,
    defaultLevel: opts.defaultLevel ?? "supervised",
    maxLevel: opts.maxLevel ?? "accept-edits",
    adapters: { "claude-sdk": fake.factory },
    now: () => ++clock,
    newId: () => `id${++ids}`,
    isDirectory: (p) => p.startsWith("/repo"),
  });
  manager.init();
  const events: HubEvent[] = [];
  manager.subscribe((e) => events.push(e));
  const types = () => events.map((e) => e.event.type);
  return { log, manager, fake, events, types };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((r) => setImmediate(r));

import type { HubEvent, SessionEvent, SessionSummary } from "../src/index.ts";

export function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    name: "faye",
    adapter: "claude-sdk",
    cwd: "/repo",
    projectRoot: "/repo",
    archived: false,
    state: "starting",
    stateProvenance: "hub",
    level: "supervised",
    costUsd: 0,
    pinned: false,
    cockpit: false,
    live: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Builds a HubEvent stream with increasing seq and at, for one session unless told otherwise. */
export function stream(events: SessionEvent[], sessionId = "s1", startSeq = 1): HubEvent[] {
  return events.map((event, i) => ({ seq: startSeq + i, at: 2000 + i, hubId: "home", sessionId, event }));
}

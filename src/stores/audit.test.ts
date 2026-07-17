import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

// The audit store is the live bus-command timeline (ADR-0007) plus its durable mirror (ADR-0012
// rule 4). Tests pin the ring semantics and the persistence side-effect; the durable SQL lives in
// sessionlog.rs and is exercised live. The client is mocked so we assert what the store *sends*.
const h = vi.hoisted(() => ({
  saveAudit: vi.fn(() => Promise.resolve()),
  recentAudit: vi.fn(() => Promise.resolve([])),
  clearAuditLog: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/auditClient", () => ({
  saveAudit: h.saveAudit,
  recentAudit: h.recentAudit,
  clearAuditLog: h.clearAuditLog,
}));

import { audit, recordAudit, clearAudit, loadAuditHistory } from "./audit";
import type { ControlRequest } from "../ipc/protocol";

const saveAudit = h.saveAudit as Mock;
const recentAudit = h.recentAudit as Mock;
const clearAuditLog = h.clearAuditLog as Mock;

const send = (target: string): ControlRequest => ({ op: "send", target, text: "hi" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  clearAudit(); // reset the ring between tests
  vi.clearAllMocks(); // drop the clear's own persist call
});

afterEach(() => {
  vi.useRealTimers();
});

describe("audit store", () => {
  it("appends an entry and defaults origin to local", () => {
    recordAudit(send("Faye"), true);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      op: "send",
      target: "Faye",
      ok: true,
      detail: undefined,
      origin: "local",
      ts: 1000,
    });
  });

  it("records the error detail on failure", () => {
    recordAudit(send("Ghost"), false, "no live pane");
    expect(audit.entries[0]).toMatchObject({ ok: false, detail: "no live pane" });
  });

  it("carries an explicit remote origin when given", () => {
    recordAudit(send("Cleo"), true, undefined, "device:kim-pixel");
    expect(audit.entries[0].origin).toBe("device:kim-pixel");
  });

  it("mirrors every record to the durable trail (fire-and-forget)", () => {
    recordAudit(send("Faye"), true);
    expect(saveAudit).toHaveBeenCalledTimes(1);
    expect(saveAudit).toHaveBeenCalledWith({
      ts: 1000,
      op: "send",
      target: "Faye",
      ok: true,
      detail: undefined,
      origin: "local",
    });
  });

  it("a persist failure never throws into the live path", () => {
    saveAudit.mockRejectedValueOnce(new Error("db gone"));
    expect(() => recordAudit(send("Faye"), true)).not.toThrow();
    expect(audit.entries).toHaveLength(1); // the live feed still got it
  });

  it("bounds the ring at the cap, dropping oldest", () => {
    for (let i = 0; i < 520; i++) recordAudit(send(`p${i}`), true);
    expect(audit.entries).toHaveLength(500);
    expect(audit.entries[0].target).toBe("p20"); // 0..19 dropped
    expect(audit.entries[499].target).toBe("p519");
  });

  it("clear drops the ring AND wipes the durable trail", () => {
    recordAudit(send("Faye"), true);
    clearAudit();
    expect(audit.entries).toHaveLength(0);
    expect(clearAuditLog).toHaveBeenCalledTimes(1);
  });

  it("hydrates the ring from the durable trail, mapping null → undefined", async () => {
    recentAudit.mockResolvedValueOnce([
      { ts: 900, op: "spawn", target: null, ok: true, detail: null, origin: "local" },
      { ts: 950, op: "broadcast", target: "ws1", ok: false, detail: "declined", origin: "device:phone" },
    ]);
    await loadAuditHistory();
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({ op: "spawn", target: undefined, detail: undefined });
    expect(audit.entries[1]).toMatchObject({ op: "broadcast", target: "ws1", origin: "device:phone" });
  });

  it("hydration does not clobber entries already recorded this run", async () => {
    recordAudit(send("Faye"), true);
    recentAudit.mockResolvedValueOnce([
      { ts: 900, op: "spawn", target: null, ok: true, detail: null, origin: "local" },
    ]);
    await loadAuditHistory();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].target).toBe("Faye"); // the live entry, not the hydrated one
  });
});

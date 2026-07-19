import { describe, it, expect, vi, beforeEach } from "vitest";

// Trust persists via saveState/loadState (Tauri invokes) — stub them so the store is pure in tests.
vi.mock("../lib/persist", () => ({
  saveState: vi.fn(async () => {}),
  loadState: vi.fn(async () => null),
}));

import { isRemoteTrusted, trustRemoteDevice, revokeRemoteTrust, remoteTrusted } from "./remoteTrust";

// The trusted-device escape hatch (ADR-0012). These pin the load-bearing invariants: it defaults to
// OFF, it only ever bypasses Device origins (never `local`), and revoke (the unpair path) fully drops it.
describe("remoteTrust", () => {
  beforeEach(() => revokeRemoteTrust());

  it("defaults to untrusted", () => {
    expect(remoteTrusted()).toBe(false);
    expect(isRemoteTrusted("device:lan")).toBe(false);
  });

  it("trusting a device bypasses device origins but never local", () => {
    trustRemoteDevice();
    expect(remoteTrusted()).toBe(true);
    expect(isRemoteTrusted("device:lan")).toBe(true);
    // `local` has full authority already and is explicitly excluded — trust must not widen it.
    expect(isRemoteTrusted("local")).toBe(false);
  });

  it("revoke drops trust (the unpair path)", () => {
    trustRemoteDevice();
    revokeRemoteTrust();
    expect(remoteTrusted()).toBe(false);
    expect(isRemoteTrusted("device:lan")).toBe(false);
  });
});

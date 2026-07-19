import { describe, it, expect } from "vitest";
import { remoteDisposition } from "./remotePolicy";

// The deny-by-default remote policy (ADR-0012 rule 3). The fail-closed default is the load-bearing
// property — these tests pin it so a future bus op can't silently become remotely reachable.

describe("remoteDisposition", () => {
  it("allows the one reader", () => {
    expect(remoteDisposition("list")).toBe("allow");
  });

  it("gates the writers behind approval (send/read + image upload)", () => {
    expect(remoteDisposition("send")).toBe("approve");
    expect(remoteDisposition("read")).toBe("approve");
    expect(remoteDisposition("upload")).toBe("approve");
  });

  it("denies setters that merely sound like reads", () => {
    // status/attention are writes — a Device must not rewrite labels or clear borders fleet-wide.
    expect(remoteDisposition("status")).toBe("deny");
    expect(remoteDisposition("attention")).toBe("deny");
  });

  it("denies the RCE primitive and the fan-out", () => {
    expect(remoteDisposition("spawn")).toBe("deny");
    expect(remoteDisposition("broadcast")).toBe("deny");
  });

  it("denies gate manipulation (the gate.set{off}+send bypass) and role/focus/blackboard", () => {
    for (const op of ["gate.set", "gate.list", "role.set", "focus", "note.set", "note.get"]) {
      expect(remoteDisposition(op)).toBe("deny");
    }
  });

  it("fails closed for ops that do not exist yet", () => {
    expect(remoteDisposition("some.future.op")).toBe("deny");
    expect(remoteDisposition("")).toBe("deny");
  });
});

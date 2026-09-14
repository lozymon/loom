import { describe, expect, it } from "vitest";
import { LoginLimiter } from "../src/remote/loginLimiter.ts";
import { isLoopback, isTailnet, planBind } from "../src/remote/network.ts";

describe("addresses", () => {
  it("recognizes loopback", () => {
    for (const a of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1", "localhost"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["192.168.1.2", "0.0.0.0", "100.100.1.1", "::"]) expect(isLoopback(a)).toBe(false);
  });

  it("recognizes Tailscale ranges", () => {
    for (const a of ["100.64.0.1", "100.101.102.103", "100.127.255.255", "fd7a:115c:a1e0::1", "::ffff:100.90.1.1"]) {
      expect(isTailnet(a)).toBe(true);
    }
    for (const a of ["100.63.255.255", "100.128.0.0", "10.0.0.1", "fd7a:115c:a1e1::1"]) expect(isTailnet(a)).toBe(false);
  });
});

describe("planBind", () => {
  const closed = { allowUnencryptedNetwork: false };

  it("keeps loopback as is", async () => {
    expect(await planBind("127.0.0.1", closed)).toEqual({ hosts: ["127.0.0.1"], kind: "loopback" });
    expect(await planBind("localhost", closed)).toEqual({ hosts: ["127.0.0.1"], kind: "loopback" });
  });

  it("adds a Tailscale address next to loopback", async () => {
    const plan = await planBind("tailscale", { ...closed, tailscale: async () => "100.70.1.2" });
    expect(plan).toEqual({ hosts: ["127.0.0.1", "100.70.1.2"], kind: "tailnet" });
    expect(await planBind("100.70.1.2", closed)).toEqual({ hosts: ["127.0.0.1", "100.70.1.2"], kind: "tailnet" });
  });

  it("explains a missing Tailscale", async () => {
    await expect(planBind("tailscale", { ...closed, tailscale: async () => undefined })).rejects.toThrow(/Tailscale/);
  });

  it("refuses other addresses unless opted in", async () => {
    await expect(planBind("0.0.0.0", closed)).rejects.toThrow(/allowUnencryptedNetwork/);
    await expect(planBind("192.168.1.5", closed)).rejects.toThrow(/not encrypted/);
    await expect(planBind("my-host", closed)).rejects.toThrow(/not an IP/);
    const open = { allowUnencryptedNetwork: true };
    expect(await planBind("0.0.0.0", open)).toMatchObject({ hosts: ["0.0.0.0"], kind: "unencrypted" });
    expect(await planBind("192.168.1.5", open)).toMatchObject({ hosts: ["127.0.0.1", "192.168.1.5"], warning: expect.any(String) });
  });
});

describe("LoginLimiter", () => {
  it("blocks after the limit within the window and lifts the block later", () => {
    let now = 0;
    const l = new LoginLimiter({ max: 3, windowMs: 1000, blockMs: 5000, now: () => now });
    l.fail("a");
    l.fail("a");
    expect(l.isBlocked("a")).toBe(false);
    now = 1500; // the first two fell out of the window
    l.fail("a");
    expect(l.isBlocked("a")).toBe(false);
    l.fail("a");
    l.fail("a");
    expect(l.isBlocked("a")).toBe(true);
    expect(l.isBlocked("b")).toBe(false);
    now = 6600;
    expect(l.isBlocked("a")).toBe(false);
  });

  it("forgets failures after a success", () => {
    const l = new LoginLimiter({ max: 2 });
    l.fail("a");
    l.succeed("a");
    l.fail("a");
    expect(l.isBlocked("a")).toBe(false);
  });
});

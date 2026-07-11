import { describe, it, expect } from "vitest";
import { createRoot } from "solid-js";
import { openAsks, dismissAsk } from "./openAsks";
import { createAsk, replyAsk } from "../lib/askRegistry";

// The reactive mirror behind the Fleet panel's "Open asks" section (§2a/§2e). The registry's RPC
// semantics are pinned in lib/askRegistry.test.ts; here we only assert the store tracks the open set
// live — an ask created on the bus shows up, and a reply/dismiss removes it.

describe("openAsks store", () => {
  it("reflects a newly-created ask and drops it once answered", () => {
    createRoot((dispose) => {
      const before = openAsks.length;
      const id = createAsk("Cleo", "Faye", "which auth lib?", 300_000);
      expect(openAsks.length).toBe(before + 1);
      const row = openAsks.find((a) => a.id === id);
      expect(row).toMatchObject({ target: "Cleo", from: "Faye", question: "which auth lib?" });

      replyAsk(id, "lucia");
      expect(openAsks.some((a) => a.id === id)).toBe(false);
      expect(openAsks.length).toBe(before);
      dispose();
    });
  });

  it("dismissAsk retires a stuck ask", () => {
    createRoot((dispose) => {
      const before = openAsks.length;
      const id = createAsk("Wade", "Iris", "blocked?", 300_000);
      expect(openAsks.some((a) => a.id === id)).toBe(true);
      dismissAsk(id);
      expect(openAsks.some((a) => a.id === id)).toBe(false);
      expect(openAsks.length).toBe(before);
      dispose();
    });
  });
});

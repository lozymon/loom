import { describe, expect, it } from "vitest";
import { checkLevelChange, clampLevel, levelRank, PERMISSION_LEVELS } from "../src/index.ts";

describe("permission levels", () => {
  it("are ordered from least to most autonomy", () => {
    expect(PERMISSION_LEVELS.map(levelRank)).toEqual([0, 1, 2, 3]);
  });

  it("clamp to the maximum", () => {
    expect(clampLevel("full", "accept-edits")).toBe("accept-edits");
    expect(clampLevel("supervised", "accept-edits")).toBe("supervised");
  });
});

describe("checkLevelChange", () => {
  it("always allows lowering, for anyone", () => {
    expect(checkLevelChange("cockpit", "full", "supervised", "supervised")).toEqual({ ok: true });
  });

  it("lets the cockpit raise up to the hub maximum", () => {
    expect(checkLevelChange("cockpit", "supervised", "assisted", "full")).toEqual({ ok: true });
  });

  it("never lets the cockpit set full, even when the hub allows it", () => {
    const r = checkLevelChange("cockpit", "assisted", "full", "full");
    expect(r.ok).toBe(false);
  });

  it("lets a human set full when the hub allows it", () => {
    expect(checkLevelChange("human", "supervised", "full", "full")).toEqual({ ok: true });
  });

  it("blocks anyone above the hub maximum (work hub caps at accept-edits)", () => {
    expect(checkLevelChange("human", "supervised", "assisted", "accept-edits").ok).toBe(false);
    expect(checkLevelChange("cockpit", "supervised", "assisted", "accept-edits").ok).toBe(false);
  });
});

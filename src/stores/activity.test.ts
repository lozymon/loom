import { describe, it, expect } from "vitest";
import { fmtSince } from "./activity";

describe("fmtSince", () => {
  it("formats sub-minute durations as 0:SS with zero-padded seconds", () => {
    expect(fmtSince(0)).toBe("0:00");
    expect(fmtSince(5_000)).toBe("0:05");
    expect(fmtSince(42_000)).toBe("0:42");
  });

  it("formats minutes as M:SS up to an hour", () => {
    expect(fmtSince(60_000)).toBe("1:00");
    expect(fmtSince(185_000)).toBe("3:05");
    expect(fmtSince(3_599_000)).toBe("59:59");
  });

  it("switches to Hh Mm at and beyond an hour", () => {
    expect(fmtSince(3_600_000)).toBe("1h 0m");
    expect(fmtSince(3_600_000 + 125_000)).toBe("1h 2m");
  });

  it("clamps negative input (clock skew) to 0:00", () => {
    expect(fmtSince(-5_000)).toBe("0:00");
  });
});

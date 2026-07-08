import { describe, expect, it } from "vitest";
import { inputRate, modelCost, sessionCost, sessionTokens, fmtTokens, fmtUsd, type ModelUsage } from "./claudeUsage";

const blank: ModelUsage = { model: "", input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

describe("inputRate", () => {
  it("resolves known models", () => {
    expect(inputRate("claude-opus-4-8")).toBe(5);
    expect(inputRate("claude-sonnet-5")).toBe(3);
    expect(inputRate("claude-haiku-4-5")).toBe(1);
  });
  it("resolves a dated snapshot by prefix", () => {
    expect(inputRate("claude-haiku-4-5-20251001")).toBe(1);
  });
  it("returns null for an unknown model", () => {
    expect(inputRate("gpt-4")).toBeNull();
    expect(inputRate("<synthetic>")).toBeNull();
  });
});

describe("modelCost", () => {
  it("prices each token class at its rate (input, output 5x, cache read 0.1x, writes 1.25x/2x)", () => {
    // 1M of each class on Opus (input rate $5):
    // input 5 + output 25 + cacheRead 0.5 + write5m 6.25 + write1h 10 = 46.75
    const u: ModelUsage = { model: "claude-opus-4-8", input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    expect(modelCost(u)).toBeCloseTo(46.75, 6);
  });
  it("scales linearly and by tier", () => {
    // 200k output tokens on Sonnet 5 (input $3 → output $15): 0.2M * 15 = $3.00
    expect(modelCost({ ...blank, model: "claude-sonnet-5", output: 200_000 })).toBeCloseTo(3, 6);
  });
  it("returns null for an unpriced model", () => {
    expect(modelCost({ ...blank, model: "gpt-4", output: 1e6 })).toBeNull();
  });
});

describe("sessionCost / sessionTokens", () => {
  const s = { id: "x", models: [
    { model: "claude-opus-4-8", input: 100, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    { model: "gpt-4", input: 999, output: 999, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, // unpriced
  ] };
  it("sums cost across priced models, treating unpriced as 0", () => {
    // opus: 100*5/1e6 + 200*25/1e6 = 0.0005 + 0.005 = 0.0055
    expect(sessionCost(s)).toBeCloseTo(0.0055, 9);
  });
  it("sums all tokens across all models", () => {
    expect(sessionTokens(s)).toBe(100 + 200 + 999 + 999);
  });
});

describe("formatters", () => {
  it("formats tokens compactly", () => {
    expect(fmtTokens(812)).toBe("812");
    expect(fmtTokens(45_300)).toBe("45.3k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
  });
  it("formats usd compactly", () => {
    expect(fmtUsd(0.421)).toBe("$0.421");
    expect(fmtUsd(12.9)).toBe("$12.90");
    expect(fmtUsd(1200)).toBe("$1.2k");
  });
});

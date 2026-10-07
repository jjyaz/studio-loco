import { describe, expect, it } from "vitest";
import { attentionScore, clampRule, nextOutSince, riskLevel } from "@/lib/signals-risk";

describe("risk rules", () => {
  it("clamps and defaults malformed rules", () => {
    expect(clampRule({ buffer: 999, outMinutes: -4 })).toEqual({ buffer: 50, outMinutes: 0 });
    expect(clampRule({ buffer: Number.NaN })).toEqual({ buffer: 3, outMinutes: 15 });
  });
  it("tracks first-seen out-of-range time and resets when back in range", () => {
    expect(nextOutSince(true, undefined, 100)).toBe(100);
    expect(nextOutSince(true, 50, 100)).toBe(50);
    expect(nextOutSince(true, 500, 100)).toBe(100);
    expect(nextOutSince(false, 50, 100)).toBeUndefined();
  });
  it("flags plan-ready only after the threshold", () => {
    const rule = { buffer: 3, outMinutes: 10 };
    expect(riskLevel("in-range", undefined, rule, 0)).toBe("clear");
    expect(riskLevel("approaching-edge", undefined, rule, 0)).toBe("watch");
    expect(riskLevel("out-of-range", 0, rule, 9 * 60_000)).toBe("out");
    expect(riskLevel("out-of-range", 0, rule, 10 * 60_000)).toBe("plan-ready");
  });
});

describe("attention score", () => {
  it("returns undefined when any reading is missing", () => {
    expect(attentionScore({ dynamicPct: 0.1, basePct: undefined, pace: 1, feeTvlPct: 1 })).toBeUndefined();
    expect(attentionScore({ dynamicPct: 0.1, basePct: 0.1, pace: Number.NaN, feeTvlPct: 1 })).toBeUndefined();
  });
  it("is bounded 0–100", () => {
    expect(attentionScore({ dynamicPct: 0, basePct: 0.25, pace: 0, feeTvlPct: 0 })?.score).toBe(0);
    expect(attentionScore({ dynamicPct: 9, basePct: 0.25, pace: 50, feeTvlPct: 90 })?.score).toBe(100);
  });
});

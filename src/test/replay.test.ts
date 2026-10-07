// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, type RuleParams } from "@/lib/agents";
import { uiPriceFromBin } from "@/lib/bins";
import {
  parseReplayCandles,
  replayExport,
  replayWindow,
  runReplay,
  type ReplayConfig,
  type ReplayTape,
} from "@/lib/replay";
import { practiceReplayTape } from "@/lib/replay-practice";

const { v, revision, armed, baseline, ...defaults } = DEFAULT_RULE;
const start = 1_791_244_800;
function tape(ids: number[], skip: number[] = []): ReplayTape {
  const price = (id: number) => uiPriceFromBin(id + 0.15, 25, 6, 6);
  const data = ids
    .map((id, i) => ({
      timestamp: start + i * 300,
      open: price(id),
      high: price(id + 0.5),
      low: price(id - 0.5),
      close: price(id),
      volume: 10,
    }))
    .filter((_, i) => !skip.includes(i));
  const endSec = start + ids.length * 300;
  return {
    v: 1,
    source: "practice",
    pool: {
      address: "TEST",
      name: "Test",
      binStep: 25,
      decimalsX: 6,
      decimalsY: 6,
      symbolX: "X",
      symbolY: "Y",
    },
    frame: "5m",
    startSec: start,
    endSec,
    loadedAt: endSec * 1000,
    ...parseReplayCandles({ data }, "5m", start, endSec),
  };
}
const config = (patch: Partial<RuleParams> = {}, model = false, width = 20): ReplayConfig => ({
  width,
  modelRebalances: model,
  rule: { ...defaults, edgeBuffer: null, cooldownMin: 15, ...patch },
});

describe("historical replay integrity", () => {
  it("excludes incomplete/future candles and reports missing periods without interpolation", () => {
    const rows = [0, 2, 4].map((i) => ({
      timestamp: start + i * 300,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.2,
      volume: null,
    }));
    const parsed = parseReplayCandles({ data: rows }, "5m", start, start + 4 * 300);
    expect(parsed.candles.map((x) => x.t)).toEqual([start, start + 600]);
    expect(parsed.quality).toEqual({
      expectedBars: 4,
      missingBars: 2,
      excludedOutside: 1,
      gaps: 1,
    });
    expect(parsed.candles[0]?.v).toBeNull();
  });
  it("refuses duplicates, malformed prices and non-aligned timestamps", () => {
    const good = { timestamp: start, open: 1, high: 2, low: 0.5, close: 1.2 };
    for (const data of [
      [good, good],
      [good, { ...good, timestamp: start + 300, high: 0.2 }],
      [good, { ...good, timestamp: start + 1 }],
    ])
      expect(() => parseReplayCandles({ data }, "5m", start, start + 1200)).toThrow();
  });
  it("requests only completed aligned periods and enforces a bounded window", () => {
    expect(replayWindow("5m", 288, (start + 305) * 1000)).toEqual({
      startSec: start + 300 - 288 * 300,
      endSec: start + 300,
    });
    expect(() => replayWindow("5m", 501)).toThrow(/2–500/);
  });
});

describe("prefix-only Observatory rules and modeled geometry", () => {
  it("future prices cannot change any earlier decision, range, volatility or modeled move", () => {
    const ids = [0, 1, 14, 15, 25, 24, -35, -36, 200, -200];
    const short = runReplay(
      tape(ids.slice(0, 7)),
      config(
        {
          priceMovePct: 1,
          volatility: { frame: "5m", candles: 6, thresholdPct: 1.5, withdrawPct: 25 },
        },
        true,
      ),
    );
    const full = runReplay(
      tape(ids),
      config(
        {
          priceMovePct: 1,
          volatility: { frame: "5m", candles: 6, thresholdPct: 1.5, withdrawPct: 25 },
        },
        true,
      ),
    );
    expect(full.points.slice(0, 7)).toEqual(short.points);
  });
  it("preserves exact even widths and applies a frozen target only after the proposing close", () => {
    const result = runReplay(tape([0, 30, 35, 40]), config({}, true, 20));
    expect(result.points.every((p) => p.upper - p.lower + 1 === 20)).toBe(true);
    expect(result.points[1]).toMatchObject({
      lower: -10,
      upper: 9,
      modeledMove: false,
      proposal: { target: { lower: 20, upper: 39 } },
    });
    expect(result.points[2]).toMatchObject({ lower: 20, upper: 39, modeledMove: true });
    expect(result.points[3]?.proposal).toBeNull(); // same trigger still on its original cooldown
    expect(result.points[3]?.cooldownBlocked).toBe(true);
  });
  it("keeps a fixed range by default and never treats risk proposals as completed withdrawals", () => {
    const result = runReplay(tape([0, 30, 30, 30, 30]), config({ outMinutes: 5 }, false));
    expect(result.points.every((p) => p.lower === -10 && p.upper === 9)).toBe(true);
    expect(result.summary.modeledMoves).toBe(0);
    expect(result.points[2]?.proposal).toMatchObject({
      kind: "reduce",
      withdrawPct: 50,
      trigger: "out-time",
    });
    expect(result.points[3]?.proposal).toBeNull(); // risk cooldown owns decision; no rebalance fallback
  });
  it("restarts observed duration at gaps and makes discontinuous volatility unavailable", () => {
    const result = runReplay(
      tape([0, 30, 30, 30, 30, 30, 30, 30, 30], [3]),
      config({
        outMinutes: 10,
        volatility: { frame: "5m", candles: 6, thresholdPct: 1, withdrawPct: 25 },
      }),
    );
    const afterGap = result.points.find((p) => p.candle.t === start + 1200)!;
    expect(afterGap).toMatchObject({
      gapBefore: true,
      observedOutMin: 0,
      vol: { state: "unavailable" },
    });
    expect(afterGap.triggers).not.toContain("out-time");
    expect(result.points.at(-1)?.vol).toMatchObject({
      state: "unavailable",
      reason: expect.stringMatching(/missing candles/),
    });
  });
  it("does not use a mismatched volatility frame as a low-risk reading", () => {
    const result = runReplay(
      tape(Array(12).fill(0)),
      config({ volatility: { frame: "1h", candles: 6, thresholdPct: 1, withdrawPct: 25 } }),
    );
    expect(result.summary.volatilityUnavailable).toBe(11);
    expect(result.points[1]?.vol).toMatchObject({
      state: "unavailable",
      reason: expect.stringMatching(/1h.*5m/),
    });
  });
  it("distinguishes close-sample coverage from intrabar excursions and excludes initialization", () => {
    const data = tape([0, 0, 0]);
    data.candles = data.candles.map((c, i) => ({ ...c, h: i === 1 ? 1.5 : c.h }));
    const result = runReplay(data, config());
    expect(result.summary).toMatchObject({
      samples: 2,
      closesInRange: 2,
      candlesExtremaOutside: 1,
    });
    expect(result.points[0]?.extremaOutside).toBeNull();
  });
  it("changing distribution alone does not invent different range coverage", () => {
    const data = practiceReplayTape();
    const spot = runReplay(data, config({ strategy: "Spot" }, true));
    for (const strategy of ["Curve", "BidAsk"] as const)
      expect(runReplay(data, config({ strategy }, true)).summary).toEqual(spot.summary);
  });
  it("exports the exact tape, rules and limitations without financial performance claims", () => {
    const data = practiceReplayTape();
    const cfg = config();
    const result = runReplay(data, cfg);
    const report = JSON.parse(replayExport(data, cfg, result));
    expect(report.tape).toEqual(data);
    expect(report.config).toEqual(cfg);
    expect(report.assumptions).toContainEqual(
      expect.stringMatching(/profit are not reconstructed/),
    );
    expect(report.summary).not.toHaveProperty("profit");
    expect(report.summary).not.toHaveProperty("fees");
    expect(data.quality).toMatchObject({ missingBars: 2, gaps: 1 });
  });
});

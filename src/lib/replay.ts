import {
  armRule,
  balancedTarget,
  DEFAULT_RULE,
  editRule,
  evaluate,
  FRAME_MS,
  observeOut,
  observedMs,
  propose,
  volatility,
  type OutRun,
  type Proposal,
  type Rule,
  type RuleParams,
  type TriggerKind,
  type VolFrame,
  type VolReading,
} from "./agents";
import { binFromUiPrice, uiPriceFromBin } from "./bins";

export interface ReplayCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}
export interface ReplayPool {
  address: string;
  name: string;
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  symbolX: string;
  symbolY: string;
}
export interface ReplayTape {
  v: 1;
  source: "historical" | "practice";
  pool: ReplayPool;
  frame: VolFrame;
  startSec: number;
  endSec: number;
  loadedAt: number;
  candles: readonly ReplayCandle[];
  quality: { expectedBars: number; missingBars: number; excludedOutside: number; gaps: number };
}
export interface ReplayConfig {
  width: number;
  rule: RuleParams;
  modelRebalances: boolean;
}
export interface ReplayPoint {
  candle: ReplayCandle;
  activeId: number;
  lower: number;
  upper: number;
  lowPrice: number;
  highPrice: number;
  bootstrap: boolean;
  closeInRange: boolean;
  extremaOutside: boolean | null;
  gapBefore: boolean;
  modeledMove: boolean;
  observedOutMin: number;
  triggers: TriggerKind[];
  proposal: Proposal | null;
  cooldownBlocked: boolean;
  vol: VolReading | null;
}
export interface ReplayResult {
  points: ReplayPoint[];
  summary: {
    samples: number;
    closesInRange: number;
    candlesExtremaOutside: number;
    proposals: number;
    riskProposals: number;
    rebalanceProposals: number;
    modeledMoves: number;
    volatilityUnavailable: number;
  };
}
export const REPLAY_ASSUMPTIONS = [
  "Candles are completed OHLCV periods; decisions use only the prefix available at that close.",
  "Bin IDs are inferred from Y-per-X candle prices and current pool metadata, not historical on-chain active-bin records.",
  "Range geometry is modeled. Token allocation, trade order, fills, fees, rewards, impermanent loss and profit are not reconstructed.",
  "Optional rebalances assume a proposal is approved at that close and its frozen target applies before the next observation. No real execution, delay or slippage is modeled.",
  "Risk withdrawals remain proposals. No withdrawn amount or changed portfolio is modeled.",
  "Missing candles are never interpolated. Out-of-range observation time restarts at gaps; volatility requires consecutive closes.",
  "The first close initializes the range and baseline; its intrabar path is excluded from coverage statistics.",
] as const;

export function replayWindow(frame: VolFrame, bars: number, now = Date.now()) {
  if (!Number.isSafeInteger(bars) || bars < 2 || bars > 500)
    throw new Error("Replay supports 2–500 completed candles.");
  const step = FRAME_MS[frame] / 1000;
  const endSec = Math.floor(now / FRAME_MS[frame]) * step;
  return { startSec: endSec - bars * step, endSec };
}

/** Strict replay parsing: malformed/duplicate rows are refused, never silently repaired. */
export function parseReplayCandles(
  raw: unknown,
  frame: VolFrame,
  startSec: number,
  endSec: number,
): Pick<ReplayTape, "candles" | "quality"> {
  const step = FRAME_MS[frame] / 1000;
  const expectedBars = (endSec - startSec) / step;
  if (
    !Number.isInteger(expectedBars) ||
    expectedBars < 2 ||
    expectedBars > 500 ||
    startSec % step !== 0 ||
    endSec % step !== 0
  )
    throw new Error("Invalid replay window.");
  const rows = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows) || rows.length > 502)
    throw new Error("Unexpected or oversized candle response.");
  const candles: ReplayCandle[] = [];
  const seen = new Set<number>();
  let excludedOutside = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Malformed candle row. Replay stopped.");
    const r = row as Record<string, unknown>;
    const t = r["timestamp"],
      o = r["open"],
      h = r["high"],
      l = r["low"],
      c = r["close"],
      v = r["volume"];
    if (
      typeof t !== "number" ||
      !Number.isSafeInteger(t) ||
      t <= 0 ||
      t % step !== 0 ||
      ![o, h, l, c].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    )
      throw new Error("Invalid candle timestamp or price. Replay stopped.");
    if (seen.has(t)) throw new Error("Duplicate candle timestamps. Replay stopped.");
    seen.add(t);
    const candle: ReplayCandle = {
      t,
      o: o as number,
      h: h as number,
      l: l as number,
      c: c as number,
      v: typeof v === "number" ? v : null,
    };
    if (
      candle.h < Math.max(candle.o, candle.c, candle.l) ||
      candle.l > Math.min(candle.o, candle.c, candle.h) ||
      (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))
    )
      throw new Error("Inconsistent OHLCV values. Replay stopped.");
    if (t < startSec || t >= endSec) {
      excludedOutside++;
      continue;
    }
    candles.push(candle);
  }
  candles.sort((a, b) => a.t - b.t);
  if (candles.length < 2)
    throw new Error(
      "Fewer than two completed candles were returned. Choose another pool or window.",
    );
  const gaps = candles.slice(1).filter((c, i) => c.t - candles[i]!.t > step).length;
  return {
    candles,
    quality: { expectedBars, missingBars: expectedBars - candles.length, excludedOutside, gaps },
  };
}

function inferredBin(price: number, p: ReplayPool) {
  const id = binFromUiPrice(price, p.binStep, p.decimalsX, p.decimalsY, "floor");
  if (!Number.isSafeInteger(id) || Math.abs(id) > 2_147_483_647)
    throw new Error("Candle price cannot be mapped to a valid bin.");
  return id;
}

/** Pure prefix-only rule replay. No chain writes or wallet capability exist here. */
export function runReplay(tape: ReplayTape, config: ReplayConfig): ReplayResult {
  const p = tape.pool;
  if (!Number.isInteger(config.width) || config.width < 2 || config.width > 69)
    throw new Error("Choose an exact width of 2–69 bins.");
  if (
    !Number.isInteger(p.binStep) ||
    p.binStep < 1 ||
    p.binStep > 500 ||
    ![p.decimalsX, p.decimalsY].every((n) => Number.isInteger(n) && n >= 0 && n <= 18)
  )
    throw new Error("Verified bin step and both token decimals are required.");
  const first = tape.candles[0];
  if (!first || tape.candles.length > 500) throw new Error("Replay needs a bounded candle tape.");
  const step = FRAME_MS[tape.frame];
  const firstId = inferredBin(first.c, p);
  let rule: Rule = armRule(
    editRule(DEFAULT_RULE, config.rule),
    firstId,
    p.binStep,
    first.t * 1000 + step,
  );
  let range = balancedTarget(firstId, config.width);
  let outRun: OutRun | undefined;
  let queued: { target: { lower: number; upper: number }; activeId: number; at: number } | null =
    null;
  const cooldowns: Record<string, number> = {};
  const points: ReplayPoint[] = [];
  for (let index = 0; index < tape.candles.length; index++) {
    const candle = tape.candles[index]!;
    const prev = tape.candles[index - 1];
    if (prev && (candle.t <= prev.t || ((candle.t - prev.t) * 1000) % step !== 0))
      throw new Error("Replay candles must be sorted, unique and aligned.");
    const now = candle.t * 1000 + step;
    const activeId = inferredBin(candle.c, p);
    const bootstrap = index === 0;
    const modeledMove = queued !== null;
    if (queued) {
      range = queued.target;
      // A hypothetical baseline; no confirmed-rebalance helper or real receipt is used.
      // Keep the revision stable so modeling cannot reset trigger cooldowns.
      rule = {
        ...rule,
        baseline: { activeId: queued.activeId, binStep: p.binStep, at: queued.at },
      };
      outRun = undefined;
      queued = null;
    }
    const closeInRange = activeId >= range.lower && activeId <= range.upper;
    outRun = observeOut(outRun, !closeInRange, now, step + 1000);
    const lowPrice = uiPriceFromBin(range.lower, p.binStep, p.decimalsX, p.decimalsY);
    const highPrice = uiPriceFromBin(range.upper + 1, p.binStep, p.decimalsX, p.decimalsY);
    if (!Number.isFinite(lowPrice) || !Number.isFinite(highPrice))
      throw new Error("Modeled range prices are unavailable.");
    const vol: VolReading | null = rule.volatility
      ? rule.volatility.frame !== tape.frame
        ? {
            state: "unavailable",
            reason: `Rule needs ${rule.volatility.frame} candles; this tape uses ${tape.frame}.`,
          }
        : volatility(tape.candles.slice(0, index + 1), rule.volatility.candles, tape.frame, now)
      : null;
    const input = {
      rule,
      pos: { key: "REPLAY-POSITION", pool: p.address, activeId, ...range, binStep: p.binStep },
      outRun,
      vol,
      now,
    };
    const evaluation = bootstrap ? { triggers: [], volUnknown: null } : evaluate(input);
    const proposal = bootstrap ? null : propose(input, cooldowns);
    if (proposal) {
      cooldowns[proposal.id] = now;
      if (config.modelRebalances && proposal.kind === "rebalance" && proposal.target)
        queued = { target: proposal.target, activeId, at: now };
    }
    points.push({
      candle,
      activeId,
      ...range,
      lowPrice,
      highPrice,
      bootstrap,
      closeInRange,
      extremaOutside: bootstrap ? null : candle.l < lowPrice || candle.h >= highPrice,
      gapBefore: !!prev && (candle.t - prev.t) * 1000 > step,
      modeledMove,
      observedOutMin: observedMs(outRun) / 60_000,
      triggers: evaluation.triggers.map((t) => t.kind),
      proposal,
      cooldownBlocked: evaluation.triggers.length > 0 && !proposal,
      vol,
    });
  }
  const observed = points.filter((x) => !x.bootstrap);
  return {
    points,
    summary: {
      samples: observed.length,
      closesInRange: observed.filter((x) => x.closeInRange).length,
      candlesExtremaOutside: observed.filter((x) => x.extremaOutside).length,
      proposals: observed.filter((x) => x.proposal).length,
      riskProposals: observed.filter((x) => x.proposal?.kind === "reduce").length,
      rebalanceProposals: observed.filter((x) => x.proposal?.kind === "rebalance").length,
      modeledMoves: observed.filter((x) => x.modeledMove).length,
      volatilityUnavailable: observed.filter((x) => x.vol?.state === "unavailable").length,
    },
  };
}

export function replayExport(tape: ReplayTape, config: ReplayConfig, result: ReplayResult) {
  return JSON.stringify(
    {
      format: "studio-loco-rule-replay",
      version: 1,
      engine: "prefix-close-v1",
      tape,
      config,
      assumptions: REPLAY_ASSUMPTIONS,
      summary: result.summary,
      points: result.points,
    },
    null,
    2,
  );
}

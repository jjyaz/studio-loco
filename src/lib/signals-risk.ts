/**
 * Signal Box risk thresholds and Fee Weather attention score.
 * Pure, deterministic helpers. Observations only — nothing here executes.
 */

export interface RiskRule {
  /** Bins from either edge that count as "approaching". 0–50. */
  buffer: number;
  /** Minutes out of range before the exit plan is flagged ready. 0–1440. */
  outMinutes: number;
}

export const DEFAULT_RULE: RiskRule = { buffer: 3, outMinutes: 15 };

export function clampRule(r: Partial<RiskRule> | undefined): RiskRule {
  const n = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d;
  return { buffer: n(r?.buffer, 0, 50, DEFAULT_RULE.buffer), outMinutes: n(r?.outMinutes, 0, 1440, DEFAULT_RULE.outMinutes) };
}

export type RiskLevel = "clear" | "watch" | "out" | "plan-ready";

/**
 * Track when a position was first *observed* out of range in this browser.
 * `since` is the stored first-seen timestamp (or undefined). Returns the next value to store.
 */
export function nextOutSince(isOut: boolean, since: number | undefined, now: number): number | undefined {
  if (!isOut) return undefined;
  return since !== undefined && Number.isFinite(since) && since <= now ? since : now;
}

export function riskLevel(state: "in-range" | "approaching-edge" | "out-of-range", outSince: number | undefined, rule: RiskRule, now: number): RiskLevel {
  if (state === "in-range") return "clear";
  if (state === "approaching-edge") return "watch";
  if (outSince === undefined) return "out";
  return now - outSince >= rule.outMinutes * 60_000 ? "plan-ready" : "out";
}

export interface AttentionInput {
  dynamicPct: number | undefined;
  basePct: number | undefined;
  /** 1h volume × 24 / 24h volume. */
  pace: number | undefined;
  /** 24h fees / TVL, as a percentage. */
  feeTvlPct: number | undefined;
}

export interface Attention {
  score: number;
  parts: { fee: number; pace: number; yield: number };
}

const ok = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Attention score 0–100: how much is happening in a pool right now.
 * A heuristic over reported readings, not a forecast or a yield estimate.
 * Returns undefined if any reading is missing — never guesses.
 */
export function attentionScore(i: AttentionInput): Attention | undefined {
  if (!ok(i.dynamicPct) || !ok(i.basePct) || !ok(i.pace) || !ok(i.feeTvlPct)) return undefined;
  // Fee pressure: dynamic fee relative to base, saturating at 1× base.
  const fee = i.basePct > 0 ? Math.min(1, i.dynamicPct / i.basePct) : i.dynamicPct > 0 ? 1 : 0;
  // Pace: 1× is normal; saturates at 3×.
  const pace = Math.min(1, i.pace / 3);
  // Fee/TVL over 24h; saturates at 5%.
  const yld = Math.min(1, i.feeTvlPct / 5);
  const score = Math.round(fee * 40 + pace * 35 + yld * 25);
  return { score, parts: { fee: Math.round(fee * 40), pace: Math.round(pace * 35), yield: Math.round(yld * 25) } };
}

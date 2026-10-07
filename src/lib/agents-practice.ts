/**
 * Explicit, opt-in practice scenario for Liquidity Agents. Fictional and labelled.
 * It never reaches the SDK builder or the transaction runner.
 */
import type { BinLite } from "./agents";

export const PRACTICE_OWNER = "PRACTICE-owner";
export const PRACTICE_POSITION = "PRACTICE-position-1";
export const PRACTICE_POOL = "PRACTICE-pool-TRAIN-USDC";

export interface PracticeRow {
  key: string; pair: string; activeId: number; lower: number; upper: number; binStep: number;
  mintX: string; mintY: string; decX: number; decY: number; bins: BinLite[]; label: string;
}

/** Scripted active-bin path; each Run check advances one step. */
export const PRACTICE_PATH = [1000, 1002, 1005, 1008, 1011, 1013, 1013, 1012];

export function practiceRow(step: number): PracticeRow {
  const activeId = PRACTICE_PATH[Math.min(step, PRACTICE_PATH.length - 1)]!;
  const lower = 990, upper = 1010;
  const bins: BinLite[] = [];
  for (let b = lower; b <= upper; b++) {
    // fixed fictional holdings: Y below the original centre, X above
    bins.push({ binId: b, positionXAmount: b >= 1000 ? "2500000" : "0", positionYAmount: b <= 1000 ? "1250000" : "0" });
  }
  return { key: PRACTICE_POSITION, pair: PRACTICE_POOL, activeId, lower, upper, binStep: 25, mintX: "PRACTICE-TRAIN", mintY: "PRACTICE-USDC", decX: 6, decY: 6, bins, label: "TRAIN / USDC (practice)" };
}

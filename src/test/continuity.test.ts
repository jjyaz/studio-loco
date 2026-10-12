import { describe, expect, it } from "vitest";
import {
  accountAfter,
  compareByMint,
  migrateJourney,
  parseContinuityImport,
  exportContinuity,
  strategyCosts,
  stageStatus,
  type SnapshotSummary,
} from "@/lib/continuity";
import { journey } from "./journey-fixtures";

const X = "So11111111111111111111111111111111111111112",
  Y = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const snap = (hx: string, hy: string, flip = false): SnapshotSummary => {
  const h = [
    { mint: X, decimals: 9, raw: hx },
    { mint: Y, decimals: 6, raw: hy },
  ];
  const o = flip ? [h[1]!, h[0]!] : h;
  return {
    observedAt: 1,
    slot: 1,
    checkedSlot: 1,
    activeId: 0,
    lower: 0,
    upper: 1,
    holdings: o,
    fees: o,
    claimed: [],
    bins: [],
    binCount: 0,
    accountLamports: "1",
    binStep: 10,
    rentMinimumLamports: "1",
  };
};
describe("Journey Continuity", () => {
  it("compares reversed mint orientation by address with exact raw deltas", () => {
    const rows = compareByMint(snap("100", "5"), snap("40", "905", true), "holdings");
    expect(rows.find((r) => r.mint === X)!.delta).toBe("-60");
    expect(rows.find((r) => r.mint === Y)!.delta).toBe("900");
  });
  it("closure needs a closing instruction plus an absent read; missing alone is unavailable", () => {
    expect(accountAfter(true, "absent")).toBe("closed");
    expect(accountAfter(false, "absent")).toBe("unavailable");
    expect(accountAfter(true, "failed")).toBe("unavailable");
  });
  it("v1 Journeys without Foundry links are not given a fabricated strategy", () => {
    expect(migrateJourney(journey())).toBeNull();
  });
  it("stage status reports withdrawal-confirmed and interrupted honestly", () => {
    const st = {
      planId: "p",
      sourceAccount: X,
      sourcePool: Y,
      destinationAccount: null,
      destinationPool: null,
      withdrawal: "w",
      deposit: null,
      lastAttempt: "none" as const,
    };
    expect(stageStatus(st)).toBe("withdrawal-confirmed");
    expect(stageStatus({ ...st, lastAttempt: "failed" })).toBe("interrupted");
    expect(stageStatus({ ...st, withdrawal: null })).toBe("pending");
  });
  it("empty strategies cost nothing and imports are refused without the format", () => {
    expect(() => parseContinuityImport({ format: "other" })).toThrow();
    expect(exportContinuity([]).strategies).toEqual([]);
    expect(strategyCosts({ chapters: [] } as never)).toEqual({
      lamports: "0",
      transactions: 0,
      unknown: 0,
    });
  });
});

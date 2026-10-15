import { describe, expect, it } from "vitest";
import {
  checkReservation,
  transition,
  ledgerTotals,
  remaining,
  canDeleteMissionLedger,
  type ExecutionBudget,
  type Operation,
} from "../../packages/sdk/src/ledger";

const A = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const O = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD";
const X = "So11111111111111111111111111111111111111112";
const Y = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const scope = {
  missionId: "mission-abc123",
  owner: O,
  cluster: "mainnet-beta" as const,
  pool: A,
  mintX: X,
  mintY: Y,
};
const d = "a".repeat(64);
const budget = (rev = 1): ExecutionBudget => ({
  v: 1,
  kind: "cumulative-execution-budget",
  scope,
  revision: rev,
  policyDigest: d,
  totalXRaw: "100",
  totalYRaw: "100",
  totalLamports: "10000",
  allowedActions: ["rebalance", "withdraw"],
  expiresAt: 2_000,
});
const op = (n: string, x: string, state: Operation["state"] = "reserved", rev = 1): Operation => ({
  id: `op-${n}-000000`,
  scope,
  budgetRevision: rev,
  policyDigest: d,
  action: "rebalance",
  state,
  reserved: { xRaw: x, yRaw: "0", lamports: "5000" },
  consumed: null,
  messageHash: null,
  signature: null,
  blockhash: null,
  lastValidBlockHeight: null,
  evidence: null,
  history: [{ state, at: 1 }],
});

describe("operation ledger", () => {
  it("prevents two reservations from spending the same remaining budget", () => {
    const first = op("a", "60");
    expect(checkReservation(budget(), 1, first, [], 10).ok).toBe(true);
    expect(checkReservation(budget(), 1, op("b", "60"), [first], 10)).toEqual({
      ok: false,
      reason: "exceeds",
    });
  });
  it("a new budget revision does not reset consumed or pending liability", () => {
    const spent = {
      ...op("a", "70", "confirmed"),
      consumed: { xRaw: "70", yRaw: "0", lamports: "5000" },
    };
    const pending = op("b", "20", "unknown");
    const t = ledgerTotals(scope, [spent, pending]);
    expect(t.consumed.xRaw).toBe("70");
    expect(t.reserved.xRaw).toBe("20");
    expect(remaining(budget(2), [spent, pending]).xRaw).toBe("10");
    expect(
      checkReservation(budget(2), 2, op("c", "11", "reserved", 2), [spent, pending], 10).ok,
    ).toBe(false);
  });
  it("refuses stale revisions, wrong digest/scope, expiry and disallowed actions", () => {
    expect(checkReservation(budget(1), 2, op("a", "1"), [], 10)).toEqual({
      ok: false,
      reason: "stale-revision",
    });
    expect(
      checkReservation(budget(), 1, { ...op("a", "1"), policyDigest: "b".repeat(64) }, [], 10),
    ).toEqual({ ok: false, reason: "digest" });
    expect(
      checkReservation(budget(), 1, { ...op("a", "1"), scope: { ...scope, owner: A } }, [], 10),
    ).toEqual({ ok: false, reason: "scope" });
    expect(checkReservation(budget(), 1, op("a", "1"), [], 2_000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkReservation(budget(), 1, { ...op("a", "1"), action: "claim" }, [], 10)).toEqual({
      ok: false,
      reason: "action",
    });
    expect(checkReservation(null, null, op("a", "1"), [], 10)).toEqual({
      ok: false,
      reason: "no-budget",
    });
  });
  it("rejection before broadcast releases; submitted/unknown keep the reservation", () => {
    const rejected = transition(op("a", "50"), "rejected", 5);
    expect(ledgerTotals(scope, [rejected]).reserved.xRaw).toBe("0");
    const signed = transition(op("b", "50"), "signed", 5, {
      signature: "s",
      blockhash: "b",
      messageHash: d,
      lastValidBlockHeight: 999,
    });
    const sub = transition(signed, "submitted", 6);
    const unk = transition(sub, "unknown", 7);
    expect(ledgerTotals(scope, [unk]).reserved.xRaw).toBe("50");
    expect(() => transition(unk, "failed", 8)).toThrow(/independently verified/);
    expect(() => transition(unk, "reserved" as never, 8)).toThrow(/Illegal/);
    expect(canDeleteMissionLedger(scope, [unk])).toBe(false);
  });
  it("signing requires persisted signature/blockhash; confirmation requires verified spend", () => {
    expect(() => transition(op("a", "1"), "signed", 2, { signature: "s" })).toThrow(/persist/);
    const sub = transition(
      transition(op("a", "40"), "signed", 2, {
        signature: "s",
        blockhash: "b",
        messageHash: d,
        lastValidBlockHeight: 999,
      }),
      "submitted",
      3,
    );
    expect(() =>
      transition(sub, "confirmed", 4, { consumed: { xRaw: "39", yRaw: "0", lamports: "5100" } }),
    ).toThrow();
    const c = transition(sub, "confirmed", 4, {
      consumed: { xRaw: "39", yRaw: "0", lamports: "5100" },
      independentlyVerified: true,
    });
    expect(ledgerTotals(scope, [c]).consumed).toEqual({ xRaw: "39", yRaw: "0", lamports: "5100" });
    expect(canDeleteMissionLedger(scope, [c])).toBe(true);
  });
});

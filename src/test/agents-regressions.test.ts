// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, activeBinSlippage, armRule, disarmRule, executionReadiness, proposalIsCurrent, propose, solQuoteLamports, unresolvedForOwner, volatility, volatilityKey, type ExecutionCosts } from "@/lib/agents";

const good: ExecutionCosts = { perTxFee: [5000], solOutLamports: 5000, requiredLamports: 5000, walletLamports: 10_000_000, sizes: [500], units: [100_000], simErrors: [null] };
describe("Liquidity Agent regression guards", () => {
  it("keeps active-bin movement within configured slippage, including zero", () => {
    expect(activeBinSlippage(0, 25)).toBe(0);
    expect(activeBinSlippage(10, 25)).toBe(0);
    expect(activeBinSlippage(25, 25)).toBe(1);
    expect(activeBinSlippage(50, 25)).toBe(1); // two bins = 0.500625%, greater than 0.5%
    expect(() => activeBinSlippage(-1, 25)).toThrow();
  });
  it("distinguishes different volatility rules on the same pool", () => {
    expect(volatilityKey("pool", "5m", 12)).not.toBe(volatilityKey("pool", "1h", 12));
    expect(volatilityKey("pool", "5m", 12)).not.toBe(volatilityKey("pool", "5m", 24));
  });
  it("rejects future, duplicate and gapped candles instead of computing low risk", () => {
    const now = 1_800_000_000_000;
    const candles = Array.from({ length: 13 }, (_, i) => ({ t: now / 1000 - (12 - i) * 300, c: 100 + i }));
    expect(volatility(candles, 12, "5m", now).state).toBe("ok");
    expect(volatility(candles.map((c) => ({ ...c, t: c.t + 300 })), 12, "5m", now).state).toBe("unavailable");
    expect(volatility(candles.map((c, i) => i === 5 ? { ...c, t: candles[4]!.t } : c), 12, "5m", now).state).toBe("unavailable");
    expect(volatility(candles.map((c, i) => ({ ...c, t: c.t - (i < 5 ? 300 : 0) })), 12, "5m", now).state).toBe("unavailable");
  });
  it("invalidates queued proposals when a trigger clears, a rule changes or a higher risk wins", () => {
    const rule = armRule({ ...DEFAULT_RULE, outMinutes: 1 }, 100, 25, 1);
    const pos = { key: "position", pool: "pool", activeId: 120, lower: 90, upper: 110, binStep: 25 };
    const input = { rule, pos, outRun: undefined, vol: null, now: 100_000 };
    const p = propose(input, {})!;
    expect(proposalIsCurrent(p, input)).toBe(true);
    expect(proposalIsCurrent(p, { ...input, rule: disarmRule(rule) })).toBe(false);
    expect(proposalIsCurrent(p, { ...input, pos: { ...pos, activeId: 100 } })).toBe(false);
    expect(proposalIsCurrent(p, { ...input, outRun: { startedAt: 0, lastSeen: 120_000 } })).toBe(false);
  });
  it.each([
    { walletLamports: null }, { walletLamports: NaN }, { walletLamports: -1 },
    { perTxFee: [null] }, { perTxFee: [Infinity] }, { perTxFee: [-1] },
    { requiredLamports: null }, { requiredLamports: 0 }, { requiredLamports: Number.MAX_SAFE_INTEGER + 1 },
    { solOutLamports: 1.5 }, { sizes: [1233] }, { sizes: [Infinity] },
    { units: [null] }, { units: [1_400_001] }, { simErrors: [] }, { simErrors: ["Instruction failed"] },
  ])("refuses an unusable cost review: %j", (patch) => {
    expect(executionReadiness({ ...good, ...patch })).not.toBeNull();
  });
  it("uses the reviewed upfront requirement and does not add the fee twice", () => {
    expect(executionReadiness({ ...good, walletLamports: 5000 })).toBeNull();
    expect(executionReadiness({ ...good, walletLamports: 4999 })).toMatch(/below/);
    expect(executionReadiness(good, true)).toMatch(/unresolved/);
  });
  it("keeps unresolved settlement locked across an RPC change and ignores another wallet/network", () => {
    const pending = [{ wallet: "a", cluster: "mainnet-beta", rpc: "custom", signature: "sig" }];
    expect(unresolvedForOwner(pending, "a", "mainnet-beta")?.signature).toBe("sig");
    expect(unresolvedForOwner(pending, "b", "mainnet-beta")).toBeNull();
    expect(unresolvedForOwner(pending, "a", "devnet")).toBeNull();
  });
  it("converts fractional SOL rent estimates safely and rejects bad estimates", () => {
    expect(solQuoteLamports(0.00203928)).toBe(2_039_280);
    expect(solQuoteLamports(NaN)).toBeNull();
    expect(solQuoteLamports(-1)).toBeNull();
  });
});

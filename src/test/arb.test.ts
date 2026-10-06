import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  DEFAULT_CONFIG, USDC_MINT, WSOL_MINT, U64_MAX, checkConfig, evaluateRoute, finalFloor, parseConfig,
  priorityFeeLamports, priorityPrice, realizedDeltas, type Costs, type LegQuote,
} from "@/lib/arb-math";

const costs: Costs = { baseFee: new BN(5000), priorityFee: new BN(50_000), nonRefundableRent: new BN(2_039_280), refundableRent: new BN(2_039_280) };
const IN = new BN(100_000_000); // 0.1 SOL
const legA = (o: Partial<LegQuote> = {}): LegQuote => ({ pool: "A", inMint: WSOL_MINT, outMint: USDC_MINT, requested: IN, consumed: IN, out: new BN(12_100_000), min: new BN(12_000_000), fee: new BN(40_000), protocolFee: new BN(0), impactPct: "0", ...o });
const legB = (o: Partial<LegQuote> = {}): LegQuote => ({ pool: "B", inMint: USDC_MINT, outMint: WSOL_MINT, requested: new BN(12_000_000), consumed: new BN(12_000_000), out: new BN(104_000_000), min: new BN(103_500_000), fee: new BN(4_000), protocolFee: new BN(0), impactPct: "0", ...o });
const MINP = new BN(500_000);

describe("arb math", () => {
  it("parses exact decimals and rejects bad configs", () => {
    const c = checkConfig(DEFAULT_CONFIG);
    expect(c.ok && c.inLamports.toString()).toBe("100000000");
    expect(checkConfig({ ...DEFAULT_CONFIG, inputSol: "0.1234567891" }).ok).toBe(false);
    expect(checkConfig({ ...DEFAULT_CONFIG, inputSol: "1e3" }).ok).toBe(false);
    expect(checkConfig({ ...DEFAULT_CONFIG, minProfitSol: "0" }).ok).toBe(false);
    expect(checkConfig({ ...DEFAULT_CONFIG, inputSol: "99999999999999999999" }).ok).toBe(false); // > u64
    expect(() => parseConfig({ ...DEFAULT_CONFIG, v: 2 })).toThrow();
    expect(() => parseConfig({ ...DEFAULT_CONFIG, slippageBps: 0.5 })).toThrow();
    expect(parseConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))).toEqual(DEFAULT_CONFIG);
  });

  it("priority fee never exceeds budget and rounds up like the runtime", () => {
    const p = priorityPrice(new BN(50_000), 600_000);
    expect(priorityFeeLamports(p, 600_000).lte(new BN(50_000))).toBe(true);
    expect(priorityFeeLamports(new BN(1), 1).toString()).toBe("1"); // ceil(1/1e6)
  });

  it("floor = input + base + priority + kept rent + min profit; unknown cost blocks", () => {
    const f = finalFloor(IN, MINP, costs);
    expect(f.ok && f.floor.toString()).toBe(String(100_000_000 + 5000 + 50_000 + 2_039_280 + 500_000));
    expect(finalFloor(IN, MINP, { ...costs, baseFee: null }).ok).toBe(false);
    expect(finalFloor(IN, MINP, { ...costs, nonRefundableRent: null }).ok).toBe(false);
    expect(finalFloor(U64_MAX, MINP, costs).ok).toBe(false);
  });

  it("profitable route: DLMM fee not subtracted twice; conservative uses leg B min", () => {
    const v = evaluateRoute(legA(), legB(), MINP, costs);
    expect(v.kind).toBe("profitable");
    if (v.kind !== "profitable") return;
    const c = 5000 + 50_000 + 2_039_280;
    expect(v.expectedProfit.toString()).toBe(String(104_000_000 - 100_000_000 - c));
    expect(v.conservativeProfit.toString()).toBe(String(103_500_000 - 100_000_000 - c));
    expect(v.residualUsdc.toString()).toBe("100000");
  });

  it("unprofitable when min out cannot cover floor", () => {
    const v = evaluateRoute(legA(), legB({ min: new BN(102_000_000) }), MINP, costs);
    expect(v.kind).toBe("unprofitable");
  });
  it("unknown fee -> unprofitable/blocked, never zero", () => {
    const v = evaluateRoute(legA(), legB(), MINP, { ...costs, priorityFee: null });
    expect(v.kind).toBe("unprofitable");
    if (v.kind === "unprofitable") expect(v.expectedProfit).toBeNull();
  });
  it("leg-2 funding bound: input must equal leg A minimum, not expected out", () => {
    expect(evaluateRoute(legA(), legB({ requested: new BN(12_100_000), consumed: new BN(12_100_000) }), MINP, costs).kind).toBe("invalid");
  });
  it("rejects mint orientation errors, duplicate pools and partial fills", () => {
    expect(evaluateRoute(legA({ inMint: USDC_MINT, outMint: WSOL_MINT }), legB(), MINP, costs).kind).toBe("invalid");
    expect(evaluateRoute(legA(), legB({ pool: "A" }), MINP, costs).kind).toBe("invalid");
    expect(evaluateRoute(legA({ consumed: new BN(99_000_000) }), legB(), MINP, costs).kind).toBe("invalid");
    expect(evaluateRoute(legA(), legB({ consumed: new BN(11_000_000) }), MINP, costs).kind).toBe("invalid");
  });
  it("realized deltas come from metadata, owner-scoped", () => {
    const d = realizedDeltas({ fee: 55_000, err: null, preBalances: [1_000_000_000], postBalances: [1_001_000_000],
      preTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: "me", uiTokenAmount: { amount: "5" } }, { accountIndex: 3, mint: USDC_MINT, owner: "pool", uiTokenAmount: { amount: "999" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_MINT, owner: "me", uiTokenAmount: { amount: "105" } }, { accountIndex: 3, mint: USDC_MINT, owner: "pool", uiTokenAmount: { amount: "1" } }] }, "me");
    expect(d.lamports.toString()).toBe("1000000");
    expect(d.usdc.toString()).toBe("100");
    expect(d.failed).toBe(false);
  });
});

import BN from "bn.js";
import { parseUnits } from "./amount";

/**
 * Pure, exact-integer evaluation for a SOL -> USDC (pool A) -> SOL (pool B) DLMM round trip.
 * No floats touch raw amounts. DLMM fees are already inside SDK swapQuote outputs and are
 * displayed only — never subtracted a second time.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const QUOTE_TTL_MS = 20_000;
export const BASE_FEE_PER_SIGNATURE = 5_000;
/** Solana legacy/v0 packet limit. */
export const MAX_TX_BYTES = 1232;
export const MAX_POOLS = 5;
export const U64_MAX = new BN("18446744073709551615");

export interface LegQuote {
  pool: string;
  inMint: string;
  outMint: string;
  /** requested input (raw) */
  requested: BN;
  consumed: BN;
  out: BN;
  min: BN;
  /** DLMM fee in input units — informational, already deducted from `out`. */
  fee: BN;
  protocolFee: BN;
  impactPct: string;
}

export interface ArbConfig {
  v: 1;
  inputSol: string;
  minProfitSol: string;
  slippageBps: number;
  priorityFeeSol: string;
  computeUnits: number;
  intervalSec: number;
  maxPools: number;
}

export const DEFAULT_CONFIG: ArbConfig = {
  v: 1, inputSol: "0.1", minProfitSol: "0.0005", slippageBps: 30, priorityFeeSol: "0.00005",
  computeUnits: 600_000, intervalSec: 20, maxPools: 4,
};

export type ConfigCheck = { ok: true; inLamports: BN; minProfit: BN; priorityBudget: BN } | { ok: false; error: string };

/** Validate a (possibly imported) config. Unknown/invalid fields are rejected, never defaulted silently. */
export function parseConfig(raw: unknown): ArbConfig {
  const o = raw as Partial<ArbConfig> | null;
  if (!o || o.v !== 1) throw new Error("Unsupported config version (expected v: 1)");
  const s = (k: keyof ArbConfig) => { if (typeof o[k] !== "string") throw new Error(`Config field ${k} must be a decimal string`); return o[k] as string; };
  const n = (k: keyof ArbConfig, lo: number, hi: number) => { const v = o[k]; if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`Config field ${k} must be an integer ${lo}–${hi}`); return v; };
  const c: ArbConfig = { v: 1, inputSol: s("inputSol"), minProfitSol: s("minProfitSol"), slippageBps: n("slippageBps", 1, 300), priorityFeeSol: s("priorityFeeSol"), computeUnits: n("computeUnits", 200_000, 1_400_000), intervalSec: n("intervalSec", 10, 600), maxPools: n("maxPools", 2, MAX_POOLS) };
  const chk = checkConfig(c);
  if (!chk.ok) throw new Error(chk.error);
  return c;
}

export function checkConfig(c: ArbConfig): ConfigCheck {
  const a = parseUnits(c.inputSol, SOL_DECIMALS);
  if (!a.ok) return { ok: false, error: `Input SOL: ${a.error}` };
  if (a.raw.isZero()) return { ok: false, error: "Input SOL must be greater than 0" };
  if (a.raw.gt(U64_MAX)) return { ok: false, error: "Input SOL exceeds u64" };
  const p = parseUnits(c.minProfitSol, SOL_DECIMALS);
  if (!p.ok) return { ok: false, error: `Minimum net profit: ${p.error}` };
  if (p.raw.isZero()) return { ok: false, error: "Minimum net profit must be greater than 0" };
  const f = parseUnits(c.priorityFeeSol, SOL_DECIMALS);
  if (!f.ok) return { ok: false, error: `Priority fee budget: ${f.error}` };
  if (f.raw.gt(new BN(100_000_000))) return { ok: false, error: "Priority fee budget is capped at 0.1 SOL" };
  if (!Number.isInteger(c.slippageBps) || c.slippageBps < 1 || c.slippageBps > 300) return { ok: false, error: "Slippage must be 0.01%–3%" };
  return { ok: true, inLamports: a.raw, minProfit: p.raw, priorityBudget: f.raw };
}

/** micro-lamports per CU so that price*units never exceeds the lamport budget. */
export function priorityPrice(budgetLamports: BN, computeUnits: number): BN {
  if (computeUnits <= 0) throw new Error("computeUnits must be positive");
  return budgetLamports.mul(new BN(1_000_000)).div(new BN(computeUnits));
}
/** Exact priority fee charged by the runtime: ceil(price * units / 1e6). */
export function priorityFeeLamports(microLamports: BN, computeUnits: number): BN {
  const num = microLamports.mul(new BN(computeUnits));
  const d = new BN(1_000_000);
  return num.add(d.subn(1)).div(d);
}

export interface Costs {
  /** base signature fee from getFeeForMessage / known per-signature fee; null = unknown */
  baseFee: BN | null;
  priorityFee: BN | null;
  /** rent for accounts this tx creates and does NOT close (e.g. a new USDC ATA); null = unknown */
  nonRefundableRent: BN | null;
  /** rent that is created and returned inside the same tx (temporary WSOL ATA) */
  refundableRent: BN | null;
}

/** Final enforced SOL floor = input + fees + kept rent + min profit. Unknown costs block. */
export function finalFloor(input: BN, minProfit: BN, c: Costs): { ok: true; floor: BN; costs: BN } | { ok: false; error: string } {
  if (c.baseFee === null) return { ok: false, error: "Network fee is unknown — execution blocked" };
  if (c.priorityFee === null) return { ok: false, error: "Priority fee is unknown — execution blocked" };
  if (c.nonRefundableRent === null) return { ok: false, error: "Account-creation rent is unknown — execution blocked" };
  const costs = c.baseFee.add(c.priorityFee).add(c.nonRefundableRent);
  const floor = input.add(costs).add(minProfit);
  if (floor.gt(U64_MAX)) return { ok: false, error: "Required output exceeds u64" };
  return { ok: true, floor, costs };
}

export type RouteVerdict =
  | { kind: "profitable"; floor: BN; costs: BN; expectedProfit: BN; conservativeProfit: BN; residualUsdc: BN; legBMinOut: BN }
  | { kind: "unprofitable"; reason: string; expectedProfit: BN | null }
  | { kind: "invalid"; reason: string };

/**
 * Evaluate a fully quoted route. Leg B MUST have been quoted with input = leg A minimum output
 * (the enforceable amount), so a pre-existing USDC balance can never fund leg B.
 */
export function evaluateRoute(a: LegQuote, b: LegQuote, minProfit: BN, costs: Costs): RouteVerdict {
  if (a.pool === b.pool) return { kind: "invalid", reason: "Both legs use the same pool" };
  if (a.inMint !== WSOL_MINT || a.outMint !== USDC_MINT) return { kind: "invalid", reason: "Leg A must be WSOL → USDC" };
  if (b.inMint !== USDC_MINT || b.outMint !== WSOL_MINT) return { kind: "invalid", reason: "Leg B must be USDC → WSOL" };
  if (!a.consumed.eq(a.requested)) return { kind: "invalid", reason: "Leg A would be a partial fill" };
  if (!b.requested.eq(a.min)) return { kind: "invalid", reason: "Leg B input must equal leg A's enforceable minimum output" };
  if (b.requested.gt(a.min)) return { kind: "invalid", reason: "Leg B input exceeds leg A minimum" };
  if (!b.consumed.eq(b.requested)) return { kind: "invalid", reason: "Leg B would be a partial fill" };
  if (a.min.isZero() || b.min.isZero()) return { kind: "invalid", reason: "A leg's minimum output is zero" };
  const f = finalFloor(a.requested, minProfit, costs);
  const totalCost = f.ok ? f.costs : null;
  const expectedProfit = totalCost ? b.out.sub(a.requested).sub(totalCost) : null;
  if (!f.ok) return { kind: "unprofitable", reason: f.error, expectedProfit: null };
  if (b.min.lt(f.floor)) {
    return { kind: "unprofitable", reason: "Minimum SOL out after slippage does not cover input + fees + kept rent + minimum net profit", expectedProfit };
  }
  return {
    kind: "profitable", floor: f.floor, costs: f.costs, expectedProfit: expectedProfit!,
    conservativeProfit: b.min.sub(a.requested).sub(f.costs), residualUsdc: a.out.sub(a.min), legBMinOut: b.min,
  };
}

/** Lamport/token deltas from a confirmed transaction's metadata. */
export interface TxMetaLike {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
  postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
  err: unknown;
}
export function realizedDeltas(meta: TxMetaLike, owner: string, feePayerIndex = 0) {
  const sum = (arr: TxMetaLike["preTokenBalances"], mint: string) =>
    (arr ?? []).filter((t) => t.mint === mint && t.owner === owner).reduce((s, t) => s.add(new BN(t.uiTokenAmount.amount)), new BN(0));
  const lamports = new BN(meta.postBalances[feePayerIndex] ?? 0).sub(new BN(meta.preBalances[feePayerIndex] ?? 0));
  const wsol = sum(meta.postTokenBalances, WSOL_MINT).sub(sum(meta.preTokenBalances, WSOL_MINT));
  const usdc = sum(meta.postTokenBalances, USDC_MINT).sub(sum(meta.preTokenBalances, USDC_MINT));
  return { fee: new BN(meta.fee), lamports, wsol, usdc, netSol: lamports.add(wsol), failed: meta.err != null };
}

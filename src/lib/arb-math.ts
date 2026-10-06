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
export const DECIMALS: Record<string, number> = { [WSOL_MINT]: 9, [USDC_MINT]: 6 };
export const QUOTE_TTL_MS = 20_000;
/** Solana packet limit. */
export const MAX_TX_BYTES = 1232;
export const MAX_POOLS = 5;
export const U64_MAX = new BN("18446744073709551615");
export const isU64 = (v: BN) => !v.isNeg() && v.lte(U64_MAX);

export interface LegQuote {
  pool: string;
  inMint: string;
  outMint: string;
  /** requested input (raw) */
  requested: BN;
  consumed: BN;
  out: BN;
  min: BN;
  /** Total DLMM fee (already reflected in `out`) in `feeMint` units; protocolFee is a share of it. */
  fee: BN;
  protocolFee: BN;
  feeMint: string;
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
  computeUnits: 600_000, intervalSec: 60, maxPools: 4,
};

export const LIMITS = {
  slippageBps: [1, 300], computeUnits: [200_000, 1_400_000], intervalSec: [30, 600], maxPools: [2, MAX_POOLS],
} as const;
const KEYS = Object.keys(DEFAULT_CONFIG).sort().join(",");
/** Max SOL input accepted (1,000,000 SOL) — keeps every derived sum far inside u64. */
const MAX_INPUT = new BN("1000000000000000");

export type Validated = { ok: true; cfg: ArbConfig; inLamports: BN; minProfit: BN; priorityBudget: BN } | { ok: false; error: string };

/**
 * The ONE config validator: storage, import, form state and every disabled state go through it.
 * Rejects unknown/missing keys, non-integer or non-finite numbers, out-of-range values. Never rounds.
 */
export function validateConfig(raw: unknown): Validated {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Config must be an object" };
  const o = raw as Record<string, unknown>;
  if (o["v"] !== 1) return { ok: false, error: "Unsupported config version (expected v: 1)" };
  if (Object.keys(o).sort().join(",") !== KEYS) return { ok: false, error: `Config keys must be exactly: ${KEYS}` };
  for (const k of ["inputSol", "minProfitSol", "priorityFeeSol"] as const) if (typeof o[k] !== "string") return { ok: false, error: `${k} must be a decimal string` };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < lo || v > hi) return { ok: false, error: `${k} must be a whole number ${lo}–${hi}` };
  }
  const a = parseUnits(o["inputSol"] as string, 9);
  if (!a.ok) return { ok: false, error: `Input SOL: ${a.error}` };
  if (a.raw.isZero()) return { ok: false, error: "Input SOL must be greater than 0" };
  if (a.raw.gt(MAX_INPUT)) return { ok: false, error: "Input SOL is capped at 1,000,000" };
  const p = parseUnits(o["minProfitSol"] as string, 9);
  if (!p.ok) return { ok: false, error: `Minimum net profit: ${p.error}` };
  if (p.raw.isZero()) return { ok: false, error: "Minimum net profit must be greater than 0" };
  if (p.raw.gt(MAX_INPUT)) return { ok: false, error: "Minimum net profit is too large" };
  const f = parseUnits(o["priorityFeeSol"] as string, 9);
  if (!f.ok) return { ok: false, error: `Priority fee budget: ${f.error}` };
  if (f.raw.gt(new BN(100_000_000))) return { ok: false, error: "Priority fee budget is capped at 0.1 SOL" };
  return { ok: true, cfg: o as unknown as ArbConfig, inLamports: a.raw, minProfit: p.raw, priorityBudget: f.raw };
}

/** Parse a text form value into an integer without rounding; invalid → NaN (rejected by validateConfig). */
export function strictInt(s: string): number {
  return /^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : Number.NaN;
}

/** micro-lamports per CU so that price*units never exceeds the lamport budget. */
export function priorityPrice(budgetLamports: BN, computeUnits: number): BN {
  if (!Number.isInteger(computeUnits) || computeUnits <= 0) throw new Error("computeUnits must be a positive integer");
  return budgetLamports.mul(new BN(1_000_000)).div(new BN(computeUnits));
}
/** Exact priority fee charged by the runtime: ceil(price * units / 1e6). */
export function priorityFeeLamports(microLamports: BN, computeUnits: number): BN {
  const d = new BN(1_000_000);
  return microLamports.mul(new BN(computeUnits)).add(d.subn(1)).div(d);
}

export interface Costs {
  /** getFeeForMessage for the compiled message — includes the priority fee. null = unknown (blocks). */
  networkFee: BN | null;
  /** Priority part of networkFee (display only, never added again). */
  priorityPart: BN | null;
  /** "exact" = fee for the actual message; "estimate" = RPC fee for a representative message (read-only scans). */
  feeSource: "exact" | "estimate";
  /** rent for accounts this tx creates and does NOT close (e.g. a new USDC ATA); null = unknown */
  nonRefundableRent: BN | null;
  /** rent deposited and returned inside the same tx (temporary WSOL ATA) */
  refundableRent: BN | null;
}

/** Split an RPC fee into base + priority for display; inconsistent → unknown parts. */
export function splitFee(networkFee: BN | null, priority: BN): { base: BN | null; priority: BN | null } {
  if (!networkFee || networkFee.lt(priority)) return { base: null, priority: null };
  return { base: networkFee.sub(priority), priority };
}

/** Final enforced SOL floor = input + network fee + kept rent + min profit. Unknown costs block. */
export function finalFloor(input: BN, minProfit: BN, c: Costs): { ok: true; floor: BN; costs: BN } | { ok: false; error: string } {
  if (c.networkFee === null) return { ok: false, error: "Network fee is unknown — execution blocked" };
  if (c.nonRefundableRent === null) return { ok: false, error: "Account-creation rent is unknown — execution blocked" };
  if (!isU64(input) || !isU64(minProfit) || !isU64(c.networkFee) || !isU64(c.nonRefundableRent)) return { ok: false, error: "Amount outside u64" };
  const costs = c.networkFee.add(c.nonRefundableRent);
  const floor = input.add(costs).add(minProfit);
  if (!isU64(floor)) return { ok: false, error: "Required output exceeds u64" };
  return { ok: true, floor, costs };
}

export type RouteVerdict =
  | { kind: "profitable"; floor: BN; costs: BN; expectedProfit: BN; conservativeProfit: BN; residualUsdc: BN; legBMinOut: BN }
  | { kind: "unprofitable"; reason: string; expectedProfit: BN | null }
  | { kind: "invalid"; reason: string };

/** Leg shape checks shared by evaluation and transaction composition. */
export function legError(a: LegQuote, b: LegQuote): string | null {
  if (a.pool === b.pool) return "Both legs use the same pool";
  if (a.inMint !== WSOL_MINT || a.outMint !== USDC_MINT) return "Leg A must be WSOL → USDC";
  if (b.inMint !== USDC_MINT || b.outMint !== WSOL_MINT) return "Leg B must be USDC → WSOL";
  for (const v of [a.requested, a.consumed, a.out, a.min, b.requested, b.consumed, b.out, b.min]) if (!isU64(v)) return "Quote amount outside u64";
  if (a.requested.isZero()) return "Leg A input is zero";
  if (!a.consumed.eq(a.requested)) return "Leg A would be a partial fill";
  if (!b.requested.eq(a.min)) return "Leg B input must equal leg A's enforceable minimum output";
  if (!b.consumed.eq(b.requested)) return "Leg B would be a partial fill";
  if (a.min.isZero() || b.min.isZero()) return "A leg's minimum output is zero";
  if (a.min.gt(a.out) || b.min.gt(b.out)) return "Minimum output exceeds expected output";
  return null;
}

/**
 * Evaluate a fully quoted route. Leg B MUST have been quoted with input = leg A minimum output
 * (the enforceable amount), so a pre-existing USDC balance can never fund leg B.
 */
export function evaluateRoute(a: LegQuote, b: LegQuote, minProfit: BN, costs: Costs): RouteVerdict {
  const le = legError(a, b);
  if (le) return { kind: "invalid", reason: le };
  const f = finalFloor(a.requested, minProfit, costs);
  if (!f.ok) return { kind: "unprofitable", reason: f.error, expectedProfit: null };
  const expectedProfit = b.out.sub(a.requested).sub(f.costs);
  if (b.min.lt(f.floor)) return { kind: "unprofitable", reason: "Minimum SOL out after slippage does not cover input + fees + kept rent + minimum net profit", expectedProfit };
  return { kind: "profitable", floor: f.floor, costs: f.costs, expectedProfit, conservativeProfit: b.min.sub(a.requested).sub(f.costs), residualUsdc: a.out.sub(a.min), legBMinOut: b.min };
}

/* ---------------- receipt deltas ---------------- */

type TokBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
export interface TxMetaLike {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokBal[] | null;
  postTokenBalances?: TokBal[] | null;
  err: unknown;
}
export interface Deltas { failed: boolean; fee: BN | null; lamports: BN | null; wsol: BN | null; usdc: BN | null; netSol: BN | null }

/** Owner-scoped deltas from confirmed metadata. Missing/unsafe data → null (UNKNOWN), never zero. */
export function realizedDeltas(meta: TxMetaLike | null | undefined, owner: string, feePayerIndex = 0): Deltas {
  const none: Deltas = { failed: false, fee: null, lamports: null, wsol: null, usdc: null, netSol: null };
  if (!meta || typeof meta !== "object") return none;
  const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const failed = meta.err != null;
  const fee = safe(meta.fee) ? new BN(meta.fee) : null;
  const pre = meta.preBalances?.[feePayerIndex], post = meta.postBalances?.[feePayerIndex];
  const lamports = safe(pre) && safe(post) ? new BN(post).sub(new BN(pre)) : null;
  const tokSum = (arr: TokBal[] | null | undefined, mint: string): BN | null => {
    if (!Array.isArray(arr)) return null;
    let s = new BN(0);
    for (const t of arr) {
      if (!t || typeof t.mint !== "string") return null;
      if (t.mint !== mint) continue;
      if (typeof t.owner !== "string") return null; // can't attribute → unknown
      if (t.owner !== owner) continue;
      const amt = t.uiTokenAmount?.amount;
      if (typeof amt !== "string" || !/^\d{1,20}$/.test(amt)) return null;
      s = s.add(new BN(amt));
    }
    return s;
  };
  const d = (mint: string) => { const a = tokSum(meta.preTokenBalances, mint), b = tokSum(meta.postTokenBalances, mint); return a && b ? b.sub(a) : null; };
  const wsol = d(WSOL_MINT), usdc = d(USDC_MINT);
  return { failed, fee, lamports, wsol, usdc, netSol: lamports && wsol ? lamports.add(wsol) : null };
}

/**
 * Liquidity Agents chain layer: exact same-pair discovery, real OHLCV volatility,
 * native DLMM rebalance composition (SDK 1.9.14 balanced strategy) and partial withdrawals.
 * Builds and SIMULATES only. Signing/sending happens exclusively in the shared runner (src/lib/tx.ts).
 */
import BN from "bn.js";
import type { Connection, PublicKey as PK, Transaction, TransactionInstruction } from "@solana/web3.js";
import { METEORA_API, fetchJson, normalizePool, fetchOhlcv, type ApiPool } from "./meteora-api";
import { getPool, invalidatePool, loadSdk } from "./dlmm";
import { withTimeout } from "./tx";
import { STRATEGY_TYPE_VALUE, type StrategyName } from "./strategy";
import { balancedTarget, pairOrientation, volatility, FRAME_MS, type VolFrame, type VolReading } from "./agents";

export const MAX_TX_BYTES = 1232;
const T = 12_000;

export interface PairPool { pool: ApiPool; orientation: "same" | "reversed" }
export interface PairScan { rows: PairPool[]; rejected: number; fetchedAt: number; universe: string }

/** Exact mint-address filter in both orientations, ≤20 per orientation by TVL, blacklisted dropped. */
export async function discoverSamePair(mintX: string, mintY: string, signal?: AbortSignal): Promise<PairScan> {
  const rows: PairPool[] = [];
  let rejected = 0;
  for (const [x, y] of [[mintX, mintY], [mintY, mintX]] as const) {
    const url = `${METEORA_API}/pools?page=1&page_size=20&sort_by=tvl:desc&filter_by=${encodeURIComponent(`token_x=${x}&&token_y=${y}`)}`;
    const page = await fetchJson<{ data: unknown[] }>(url, { signal });
    if (!page || !Array.isArray(page.data)) throw new Error("Unexpected pool list shape");
    for (const r of page.data) {
      const p = normalizePool(r);
      if (!p) { rejected++; continue; }
      const o = pairOrientation(p.token_x.address, p.token_y.address, mintX, mintY);
      if (!o || p.is_blacklisted) { rejected++; continue; }
      if (!rows.some((q) => q.pool.address === p.address)) rows.push({ pool: p, orientation: o });
    }
  }
  rows.sort((a, b) => (b.pool.tvl ?? -1) - (a.pool.tvl ?? -1));
  return { rows, rejected, fetchedAt: Date.now(), universe: `Exact ${mintX.slice(0, 4)}…/${mintY.slice(0, 4)}… pools, both orientations, ≤20 each by TVL, blacklisted excluded` };
}

/** Real mainnet OHLCV only. Devnet has no indexed candles, so the reading is unavailable (not low). */
export async function readVolatility(pool: string, cluster: string, frame: VolFrame, candles: number, signal?: AbortSignal): Promise<VolReading> {
  if (cluster !== "mainnet-beta") return { state: "unavailable", reason: "Price history is only indexed on mainnet." };
  const now = Date.now();
  const end = Math.floor(now / 1000);
  const start = end - Math.ceil(((candles + 3) * FRAME_MS[frame]) / 1000);
  try {
    const c = await fetchOhlcv(pool, frame, start, end, signal);
    return volatility(c.map((k) => ({ t: k.t, c: k.c })), candles, frame, now);
  } catch (e) {
    return { state: "unavailable", reason: e instanceof Error ? e.message : "Price history unavailable" };
  }
}

export interface CostReview {
  /** Sum of getFeeForMessage across txs; null = unknown (blocks). */
  feeLamports: number | null;
  perTxFee: (number | null)[];
  /** Simulated wallet SOL outflow (wraps, rent, ATAs). null = unknown (blocks). */
  solOutLamports: number | null;
  walletLamports: number | null;
  sizes: number[];
  units: (number | null)[];
  simErrors: (string | null)[];
  logs: string[][];
}

export interface BuiltRebalance {
  kind: "atomic" | "split";
  txs: { label: string; tx: Transaction }[];
  target: { lower: number; upper: number };
  activeId: number;
  width: number;
  binArrayCost: number;
  bitmapExtensionCost: number;
  binArrayCount: number;
  withdrawn: { x: string; y: string };
  deposited: { x: string; y: string };
  maxActiveBinSlippage: number;
  costs: CostReview;
}

export type RebalanceResult = { ok: true; built: BuiltRebalance } | { ok: false; staged: true; reason: string };

/** Verifies the SDK response targets exactly the reviewed range with zero top-up. Returns a reason when it doesn't. */
export function verifyRebalanceTarget(o: {
  activeId: number; width: number; expected: { lower: number; upper: number };
  deposits: { minDeltaId: BN; maxDeltaId: BN }[]; depositedX: BN; depositedY: BN; availX: BN; availY: BN;
}): string | null {
  if (o.deposits.length !== 1) return `Expected one deposit range, got ${o.deposits.length}.`;
  const d = o.deposits[0]!;
  const lower = o.activeId + d.minDeltaId.toNumber(), upper = o.activeId + d.maxDeltaId.toNumber();
  if (lower !== o.expected.lower || upper !== o.expected.upper) return `SDK target ${lower}–${upper} differs from the reviewed ${o.expected.lower}–${o.expected.upper}.`;
  if (upper - lower + 1 !== o.width) return "SDK target would change the range width.";
  if (o.depositedX.gt(o.availX) || o.depositedY.gt(o.availY)) return "SDK deposit exceeds what the position holds — a wallet top-up would be required.";
  return null;
}

async function reviewCosts(connection: Connection, owner: PK, txs: Transaction[]): Promise<CostReview> {
  const { VersionedTransaction } = await import("@solana/web3.js");
  const walletLamports = await withTimeout(connection.getBalance(owner, "confirmed"), T, "Wallet balance").catch(() => null);
  const out: CostReview = { feeLamports: 0, perTxFee: [], solOutLamports: 0, walletLamports, sizes: [], units: [], simErrors: [], logs: [] };
  let running = walletLamports;
  for (const tx of txs) {
    let size = Infinity;
    try { size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* oversize */ }
    out.sizes.push(size);
    if (size > MAX_TX_BYTES) { out.perTxFee.push(null); out.units.push(null); out.simErrors.push(`Transaction is ${Number.isFinite(size) ? size : ">" + MAX_TX_BYTES} bytes; the limit is ${MAX_TX_BYTES}.`); out.logs.push([]); out.feeLamports = null; out.solOutLamports = null; continue; }
    const msg = tx.compileMessage();
    const fee = await withTimeout(connection.getFeeForMessage(msg, "confirmed"), T, "Network fee").then((r) => r.value).catch(() => null);
    out.perTxFee.push(fee);
    if (fee === null) out.feeLamports = null; else if (out.feeLamports !== null) out.feeLamports += fee;
    try {
      const sim = await withTimeout(connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { addresses: [owner.toBase58()], encoding: "base64" } }), T, "Simulation");
      out.units.push(sim.value.unitsConsumed ?? null);
      out.logs.push(sim.value.logs ?? []);
      out.simErrors.push(sim.value.err ? JSON.stringify(sim.value.err) : null);
      const post = sim.value.accounts?.[0]?.lamports;
      if (sim.value.err || typeof post !== "number" || running === null) out.solOutLamports = null;
      else if (out.solOutLamports !== null) { out.solOutLamports += Math.max(0, running - post); running = post; }
    } catch (e) {
      out.units.push(null); out.logs.push([]); out.simErrors.push(e instanceof Error ? e.message : String(e)); out.solOutLamports = null;
    }
    // Only the first tx simulates against real state; later txs depend on earlier ones landing.
    if (txs.length > 1) break;
  }
  return out;
}

async function freshTx(connection: Connection, owner: PK, ixs: TransactionInstruction[]): Promise<Transaction> {
  const { Transaction } = await import("@solana/web3.js");
  const { blockhash, lastValidBlockHeight } = await withTimeout(connection.getLatestBlockhash("confirmed"), T, "Blockhash");
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
  tx.add(...ixs);
  return tx;
}

/** Native rebalance: withdraw 100% + redeposit around the active bin with the SAME width and zero wallet top-up. */
export async function buildNativeRebalance(o: { connection: Connection; owner: PK; poolAddress: string; position: string; strategy: StrategyName; slippageBps: number; cluster: "mainnet-beta" | "devnet" }): Promise<RebalanceResult> {
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await loadSdk();
  invalidatePool(o.poolAddress);
  const pool = await withTimeout(getPool(o.connection, o.poolAddress, o.cluster), T, "Pool load");
  await withTimeout(pool.refetchStates(), T, "Pool refresh");
  const posKey = new PublicKey(o.position);
  const pos = await withTimeout(pool.getPosition(posKey), T, "Position read");
  if (!pos.positionData.owner.equals(o.owner)) throw new Error("Position owner does not match the connected wallet.");
  const pd = pos.positionData;
  const width = pd.upperBinId - pd.lowerBinId + 1;
  const activeId = pool.lbPair.activeId;
  const expected = balancedTarget(activeId, width);
  const resp = await withTimeout(pool.simulateRebalancePositionWithBalancedStrategy(posKey, pd, STRATEGY_TYPE_VALUE[o.strategy] as never, new BN(0), new BN(0), new BN(0), new BN(0)), T, "Rebalance simulation");
  const sim = resp.simulationResult as typeof resp.simulationResult & { depositParams?: { minDeltaId: BN; maxDeltaId: BN }[] };
  const availX = new BN(pd.totalXAmount.split(".")[0] ?? "0").add(pd.feeX);
  const availY = new BN(pd.totalYAmount.split(".")[0] ?? "0").add(pd.feeY);
  const why = verifyRebalanceTarget({ activeId, width, expected, deposits: sim.depositParams ?? [], depositedX: sim.actualAmountXDeposited, depositedY: sim.actualAmountYDeposited, availX, availY });
  if (why) return { ok: false, staged: true, reason: why };
  const binStepFrac = pool.lbPair.binStep / 10_000;
  const slipFrac = o.slippageBps / 10_000;
  const maxActive = Math.max(1, Math.ceil(Math.log(1 + slipFrac) / Math.log(1 + binStepFrac)));
  const ixs = await withTimeout(pool.rebalancePosition(resp, new BN(maxActive), o.owner, o.slippageBps / 100), T, "Rebalance instructions");
  const one = await freshTx(o.connection, o.owner, [...ixs.initBinArrayInstructions, ...ixs.rebalancePositionInstruction]);
  let size = Infinity;
  try { size = one.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* oversize */ }
  let txs: { label: string; tx: Transaction }[];
  let kind: "atomic" | "split" = "atomic";
  if (size <= MAX_TX_BYTES) txs = [{ label: "Rebalance position (withdraw + redeposit, one transaction)", tx: one }];
  else if (ixs.initBinArrayInstructions.length) {
    const a = await freshTx(o.connection, o.owner, ixs.initBinArrayInstructions);
    const b = await freshTx(o.connection, o.owner, ixs.rebalancePositionInstruction);
    let sb = Infinity; try { sb = b.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* */ }
    if (sb > MAX_TX_BYTES) return { ok: false, staged: true, reason: `The rebalance instruction alone is ${Number.isFinite(sb) ? sb : "over " + MAX_TX_BYTES} bytes, above the ${MAX_TX_BYTES}-byte limit.` };
    kind = "split";
    txs = [{ label: "1/2 Create missing price-level accounts", tx: a }, { label: "2/2 Rebalance position", tx: b }];
  } else return { ok: false, staged: true, reason: `The rebalance transaction is ${Number.isFinite(size) ? size : "over " + MAX_TX_BYTES} bytes, above the ${MAX_TX_BYTES}-byte limit.` };
  const costs = await reviewCosts(o.connection, o.owner, txs.map((t) => t.tx));
  void sdk;
  return { ok: true, built: {
    kind, txs, target: expected, activeId, width,
    binArrayCost: resp.binArrayCost, bitmapExtensionCost: resp.bitmapExtensionCost, binArrayCount: resp.binArrayCount,
    withdrawn: { x: sim.actualAmountXWithdrawn.toString(), y: sim.actualAmountYWithdrawn.toString() },
    deposited: { x: sim.actualAmountXDeposited.toString(), y: sim.actualAmountYDeposited.toString() },
    maxActiveBinSlippage: maxActive, costs,
  } };
}

export interface BuiltWithdraw { txs: { label: string; tx: Transaction }[]; bps: number; estX: string; estY: string; costs: CostReview; lower: number; upper: number }

/** Partial / full liquidity-share removal. Never closes the position and never claims beyond what removeLiquidity does. */
export async function buildWithdraw(o: { connection: Connection; owner: PK; poolAddress: string; position: string; bps: number; cluster: "mainnet-beta" | "devnet"; label: string }): Promise<BuiltWithdraw> {
  if (!Number.isInteger(o.bps) || o.bps < 1 || o.bps > 10_000) throw new Error("Withdrawal must be 0.01%–100%");
  const { PublicKey } = await import("@solana/web3.js");
  invalidatePool(o.poolAddress);
  const pool = await withTimeout(getPool(o.connection, o.poolAddress, o.cluster), T, "Pool load");
  await withTimeout(pool.refetchStates(), T, "Pool refresh");
  const posKey = new PublicKey(o.position);
  const pos = await withTimeout(pool.getPosition(posKey), T, "Position read");
  if (!pos.positionData.owner.equals(o.owner)) throw new Error("Position owner does not match the connected wallet.");
  const pd = pos.positionData;
  const txs = await withTimeout(pool.removeLiquidity({ user: o.owner, position: posKey, fromBinId: pd.lowerBinId, toBinId: pd.upperBinId, bps: new BN(o.bps), shouldClaimAndClose: false }), T, "Withdraw build");
  const list = txs.map((tx, i) => ({ label: `${o.label} (${i + 1}/${txs.length})`, tx }));
  const costs = await reviewCosts(o.connection, o.owner, list.map((l) => l.tx));
  const est = (s: string) => (BigInt(s.split(".")[0] || "0") * BigInt(o.bps) / 10_000n).toString();
  return { txs: list, bps: o.bps, estX: est(pd.totalXAmount), estY: est(pd.totalYAmount), costs, lower: pd.lowerBinId, upper: pd.upperBinId };
}

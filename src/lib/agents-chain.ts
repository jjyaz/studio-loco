/**
 * Liquidity Agents chain layer: exact same-pair discovery, real OHLCV volatility,
 * native DLMM rebalance composition (explicit exact-width SDK strategy) and partial withdrawals.
 * Builds and SIMULATES only. Signing/sending happens exclusively in the shared runner (src/lib/tx.ts).
 */
import BN from "bn.js";
import { Buffer } from "buffer";
import type { Connection, PublicKey as PK, Transaction, TransactionInstruction } from "@solana/web3.js";
import { METEORA_API, fetchJson, normalizePool, fetchOhlcv, type ApiPool } from "./meteora-api";
import { loadSdk } from "./dlmm";
import type { Job } from "./job-control";
import { STRATEGY_TYPE_VALUE, type StrategyName } from "./strategy";
import { activeBinSlippage, balancedTarget, knownLamports, pairOrientation, volatility, FRAME_MS, type VolFrame, type VolReading } from "./agents";

export const MAX_TX_BYTES = 1232;
const T = 12_000;
// SDK instruction composition contains several RPC reads plus an internal CU estimate.
// Each request is transport-bounded; this stage also has a bounded total and a drain latch.
export const NATIVE_BUILD_TIMEOUT_MS = 45_000;

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
  /** Conservative fee + newly funded writable-account rent, or net SOL outflow if larger. */
  requiredLamports: number | null;
  walletLamports: number | null;
  sizes: number[];
  units: (number | null)[];
  simErrors: (string | null)[];
  logs: string[][];
  /** Only account-creation preflight may precede a separately rebuilt native rebalance. */
  remaining: number;
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
  walletOut: { x: string; y: string };
  maxActiveBinSlippage: number;
  costs: CostReview;
}

export type RebalanceResult = { ok: true; built: BuiltRebalance } | { ok: false; staged: true; reason: string };

/** A newly created WSOL account can receive withdrawn SOL: that output is not rent paid by the wallet. */
export function newAccountRentLamports(a: { lamports: number; owner: string; data: string[] }): number | null {
  if (!knownLamports(a.lamports)) return null;
  if (a.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    if (!a.data[0] || a.data[1] !== "base64") return null;
    const data = Buffer.from(a.data[0], "base64");
    if (data.length >= 165 && data.readUInt32LE(109) === 1) {
      const reserve = Number(data.readBigUInt64LE(113));
      return knownLamports(reserve) && reserve <= a.lamports ? reserve : null;
    }
  }
  return a.lamports;
}

/** Verifies the SDK response targets exactly the reviewed range with zero top-up. Returns a reason when it doesn't. */
export function verifyRebalanceTarget(o: {
  activeId: number; width: number; expected: { lower: number; upper: number };
  deposits: { minDeltaId: BN | number; maxDeltaId: BN | number }[]; depositedX: BN; depositedY: BN; availX: BN; availY: BN;
}): string | null {
  if (o.deposits.length !== 1) return `Expected one deposit range, got ${o.deposits.length}.`;
  const d = o.deposits[0]!;
  const asInt = (n: BN | number) => BN.isBN(n) ? n.toNumber() : n;
  const lo = asInt(d.minDeltaId), hi = asInt(d.maxDeltaId);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return "SDK returned invalid bin offsets.";
  const lower = o.activeId + lo, upper = o.activeId + hi;
  if (lower !== o.expected.lower || upper !== o.expected.upper) return `SDK target ${lower}–${upper} differs from the reviewed ${o.expected.lower}–${o.expected.upper}.`;
  if (upper - lower + 1 !== o.width) return "SDK target would change the range width.";
  // SDK actualAmount*Deposited means NET input from the wallet, not gross redeposit.
  if (!o.depositedX.isZero() || !o.depositedY.isZero()) return "SDK requires a wallet top-up; this review only permits zero top-up.";
  return null;
}

export async function reviewCosts(connection: Connection, owner: PK, txs: Transaction[], job: Job): Promise<CostReview> {
  const { VersionedTransaction } = await import("@solana/web3.js");
  job.check();
  const tx = txs[0];
  if (!tx) throw new Error("No transaction to review.");
  let size = Infinity;
  try { size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* oversize */ }
  const out: CostReview = { feeLamports: null, perTxFee: [null], solOutLamports: null, requiredLamports: null, walletLamports: null, sizes: [size], units: [null], simErrors: [null], logs: [[]], remaining: Math.max(0, txs.length - 1) };
  if (size > MAX_TX_BYTES) { out.simErrors[0] = `Transaction exceeds ${MAX_TX_BYTES} bytes.`; return out; }
  const msg = tx.compileMessage();
  const keys = msg.accountKeys.filter((_, i) => msg.isAccountWritable(i));
  const ownerIndex = keys.findIndex((k) => k.equals(owner));
  if (ownerIndex < 0) throw new Error("Reviewed wallet is missing from the transaction.");
  // Track the ORIGINAL RPC promise with JobControl. A timeout cannot release the drain latch.
  const pre = await job.step(connection.getMultipleAccountsInfo(keys, "confirmed"), T, "Wallet and rent accounts");
  const balance = pre[ownerIndex]?.lamports;
  out.walletLamports = knownLamports(balance) ? balance : null;
  const fee = (await job.step(connection.getFeeForMessage(msg, "confirmed"), T, "Network fee")).value;
  out.feeLamports = out.perTxFee[0] = knownLamports(fee) ? fee : null;
  const sim = await job.step(connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { addresses: keys.map((k) => k.toBase58()), encoding: "base64" } }), T, "Exact simulation");
  out.units[0] = sim.value.unitsConsumed ?? null;
  out.logs[0] = sim.value.logs ?? [];
  out.simErrors[0] = sim.value.err ? JSON.stringify(sim.value.err) : null;
  const post = sim.value.accounts;
  const after = post?.[ownerIndex]?.lamports;
  if (!sim.value.err && post?.length === keys.length && pre.length === keys.length && knownLamports(after) && knownLamports(balance) && knownLamports(fee)) {
    // RPC simulation debits the fee. Do not add it to the wallet delta a second time.
    out.solOutLamports = Math.max(0, balance - after);
    let rent = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === ownerIndex || pre[i] !== null || post[i] === null) continue;
      const n = post[i] ? newAccountRentLamports(post[i]!) : null;
      if (!knownLamports(n) || !knownLamports(rent + n)) return out;
      rent += n;
    }
    // Refunds from old accounts cannot hide the SOL needed to fund new accounts up front.
    const required = Math.max(out.solOutLamports, fee + rent);
    out.requiredLamports = knownLamports(required) ? required : null;
  }
  return out;
}

async function freshTx(connection: Connection, owner: PK, ixs: TransactionInstruction[], job: Job): Promise<Transaction> {
  const { Transaction } = await import("@solana/web3.js");
  const { blockhash, lastValidBlockHeight } = await job.step(connection.getLatestBlockhash("confirmed"), T, "Blockhash");
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
  tx.add(...ixs);
  return tx;
}

/** Native rebalance: withdraw 100% + redeposit around the active bin with the SAME width and zero wallet top-up. */
export async function buildNativeRebalance(o: { connection: Connection; owner: PK; poolAddress: string; position: string; strategy: StrategyName; slippageBps: number; cluster: "mainnet-beta" | "devnet"; job: Job }): Promise<RebalanceResult> {
  if (!Number.isInteger(o.slippageBps) || o.slippageBps < 0 || o.slippageBps > 10_000) throw new Error("Invalid slippage.");
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await o.job.step(loadSdk(), T, "SDK load");
  const pool = await o.job.step(sdk.default.create(o.connection, new PublicKey(o.poolAddress), { cluster: o.cluster, skipSolWrappingOperation: true }), T, "Fresh pool load");
  const posKey = new PublicKey(o.position);
  const pos = await o.job.step(pool.getPosition(posKey), T, "Position read");
  if (!pos.positionData.owner.equals(o.owner)) throw new Error("Position owner does not match the connected wallet.");
  const pd = pos.positionData;
  const width = pd.upperBinId - pd.lowerBinId + 1;
  const activeId = pool.lbPair.activeId;
  const expected = balancedTarget(activeId, width);
  const availX = new BN(pd.totalXAmount.split(".")[0] ?? "0").add(pd.feeX);
  const availY = new BN(pd.totalYAmount.split(".")[0] ?? "0").add(pd.feeY);
  // The SDK's convenience balanced builder adds one bin to even widths. Use its
  // public explicit strategy API, with the SAME exact range shown in the review.
  const minDeltaId = new BN(expected.lower - activeId), maxDeltaId = new BN(expected.upper - activeId);
  const params = sdk.buildLiquidityStrategyParameters(availX, availY, minDeltaId, maxDeltaId, new BN(pool.lbPair.binStep), false, new BN(activeId), sdk.getLiquidityStrategyParameterBuilder(STRATEGY_TYPE_VALUE[o.strategy] as never));
  const resp = await o.job.step(pool.simulateRebalancePosition(posKey, pd, true, true,
    [{ minDeltaId, maxDeltaId, x0: params.x0, y0: params.y0, deltaX: params.deltaX, deltaY: params.deltaY, favorXInActiveBin: false }],
    [{ minBinId: new BN(pd.lowerBinId), maxBinId: new BN(pd.upperBinId), bps: new BN(10_000) }]), T, "Rebalance simulation");
  if (resp.rebalancePosition.lbPair.activeId !== activeId) return { ok: false, staged: true, reason: "The active bin changed during preparation. Rebuild from fresh pool state." };
  const sim = resp.simulationResult;
  const why = verifyRebalanceTarget({ activeId, width, expected, deposits: sim.depositParams ?? [], depositedX: sim.actualAmountXDeposited, depositedY: sim.actualAmountYDeposited, availX, availY });
  if (why) return { ok: false, staged: true, reason: why };
  if (sim.amountXDeposited.isZero() && sim.amountYDeposited.isZero()) return { ok: false, staged: true, reason: "This target would not redeposit any liquidity. Review a different range or a withdrawal instead." };
  const maxActive = activeBinSlippage(o.slippageBps, pool.lbPair.binStep);
  const ixs = await o.job.step(pool.rebalancePosition(resp, new BN(maxActive), o.owner, o.slippageBps / 100), NATIVE_BUILD_TIMEOUT_MS, "Rebalance instructions");
  // Keep SDK compute-budget instructions; adding another SetComputeUnitLimit is invalid.
  const one = await freshTx(o.connection, o.owner, [...ixs.initBinArrayInstructions, ...ixs.rebalancePositionInstruction], o.job);
  let size = Infinity;
  try { size = one.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* oversize */ }
  let txs: { label: string; tx: Transaction }[];
  let kind: "atomic" | "split" = "atomic";
  if (size <= MAX_TX_BYTES) txs = [{ label: "Rebalance position (withdraw + redeposit, one transaction)", tx: one }];
  else if (ixs.initBinArrayInstructions.length) {
    const a = await freshTx(o.connection, o.owner, ixs.initBinArrayInstructions, o.job);
    const b = await freshTx(o.connection, o.owner, ixs.rebalancePositionInstruction, o.job);
    let sb = Infinity; try { sb = b.serialize({ requireAllSignatures: false, verifySignatures: false }).length; } catch { /* */ }
    if (sb > MAX_TX_BYTES) return { ok: false, staged: true, reason: `The rebalance instruction alone is ${Number.isFinite(sb) ? sb : "over " + MAX_TX_BYTES} bytes, above the ${MAX_TX_BYTES}-byte limit.` };
    kind = "split";
    txs = [{ label: "1/2 Create missing price-level accounts", tx: a }, { label: "2/2 Rebalance position", tx: b }];
  } else return { ok: false, staged: true, reason: `The rebalance transaction is ${Number.isFinite(size) ? size : "over " + MAX_TX_BYTES} bytes, above the ${MAX_TX_BYTES}-byte limit.` };
  const costs = await reviewCosts(o.connection, o.owner, txs.map((t) => t.tx), o.job);
  void sdk;
  return { ok: true, built: {
    kind, txs, target: expected, activeId, width,
    binArrayCost: resp.binArrayCost, bitmapExtensionCost: resp.bitmapExtensionCost, binArrayCount: resp.binArrayCount,
    withdrawn: { x: sim.amountXDeposited.add(sim.actualAmountXWithdrawn).toString(), y: sim.amountYDeposited.add(sim.actualAmountYWithdrawn).toString() },
    deposited: { x: sim.amountXDeposited.toString(), y: sim.amountYDeposited.toString() },
    walletOut: { x: sim.actualAmountXWithdrawn.toString(), y: sim.actualAmountYWithdrawn.toString() },
    maxActiveBinSlippage: maxActive, costs,
  } };
}

export interface BuiltWithdraw { txs: { label: string; tx: Transaction }[]; bps: number; estX: string; estY: string; costs: CostReview; lower: number; upper: number; mintX: string; mintY: string }

/** Partial / full liquidity-share removal. Never closes the position and never claims beyond what removeLiquidity does. */
export async function buildWithdraw(o: { connection: Connection; owner: PK; poolAddress: string; position: string; bps: number; cluster: "mainnet-beta" | "devnet"; label: string; job: Job }): Promise<BuiltWithdraw> {
  if (!Number.isInteger(o.bps) || o.bps < 1 || o.bps > 10_000) throw new Error("Withdrawal must be 0.01%–100%");
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await o.job.step(loadSdk(), T, "SDK load");
  const pool = await o.job.step(sdk.default.create(o.connection, new PublicKey(o.poolAddress), { cluster: o.cluster, skipSolWrappingOperation: true }), T, "Fresh pool load");
  const posKey = new PublicKey(o.position);
  const pos = await o.job.step(pool.getPosition(posKey), T, "Position read");
  if (!pos.positionData.owner.equals(o.owner)) throw new Error("Position owner does not match the connected wallet.");
  const pd = pos.positionData;
  const txs = await o.job.step(pool.removeLiquidity({ user: o.owner, position: posKey, fromBinId: pd.lowerBinId, toBinId: pd.upperBinId, bps: new BN(o.bps), shouldClaimAndClose: false, skipUnwrapSOL: true }), T, "Withdraw build");
  // Rebuilding a percentage removal after sending tx[0] can remove that percentage AGAIN.
  // Until a persisted bin-chunk cursor exists, reject this path before any signature.
  if (txs.length !== 1) throw new Error(`This withdrawal needs ${txs.length} transactions. Agents currently support single-transaction withdrawals only; no funds were moved. Use the position's withdrawal flow and review every step.`);
  const list = txs.map((tx, i) => ({ label: `${o.label} (${i + 1}/${txs.length})`, tx }));
  const costs = await reviewCosts(o.connection, o.owner, list.map((l) => l.tx), o.job);
  const est = (s: string) => (BigInt(s.split(".")[0] || "0") * BigInt(o.bps) / 10_000n).toString();
  return { txs: list, bps: o.bps, estX: est(pd.totalXAmount), estY: est(pd.totalYAmount), costs, lower: pd.lowerBinId, upper: pd.upperBinId, mintX: pool.tokenX.publicKey.toBase58(), mintY: pool.tokenY.publicKey.toBase58() };
}

/** Destination labels from the API are not proof: verify both mint addresses on this RPC. */
export async function verifyStagedDestination(o: { connection: Connection; poolAddress: string; mintX: string; mintY: string; cluster: "mainnet-beta" | "devnet"; job: Job }): Promise<"same" | "reversed"> {
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await o.job.step(loadSdk(), T, "SDK load");
  const p = await o.job.step(sdk.default.create(o.connection, new PublicKey(o.poolAddress), { cluster: o.cluster, skipSolWrappingOperation: true }), T, "Destination pool verification");
  const orientation = pairOrientation(p.tokenX.publicKey.toBase58(), p.tokenY.publicKey.toBase58(), o.mintX, o.mintY);
  if (!orientation) throw new Error("Destination pool does not contain the same two mint addresses on this network.");
  return orientation;
}

import { installNodeGlobals } from "./polyfills";
installNodeGlobals();
import type { Connection, PublicKey as PK, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { fetchPools, type ApiPool } from "./meteora-api";
import { getPool, invalidatePool, DLMM_PROGRAM_ID, type DLMM } from "./dlmm";
import { withTimeout } from "./tx";
import {
  BASE_FEE_PER_SIGNATURE, MAX_POOLS, MAX_TX_BYTES, SPL_TOKEN_PROGRAM, USDC_MINT, WSOL_MINT,
  evaluateRoute, priorityFeeLamports, priorityPrice, type Costs, type LegQuote, type RouteVerdict,
} from "./arb-math";

/** Programs an arbitrage transaction may touch. Anything else rejects the build. */
export const ALLOWED_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  SPL_TOKEN_PROGRAM,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  DLMM_PROGRAM_ID,
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // DLMM swap2 memo account (v3 memo program)
]);

export interface Candidate { address: string; name: string; binStep?: number; tvl?: number }

/** Top-liquidity SOL/USDC pools from the live API, matched by exact mints (never symbols). */
export async function discoverCandidates(max: number, signal?: AbortSignal): Promise<{ pools: Candidate[]; rejected: string[] }> {
  const page = await fetchPools({ page: 1, pageSize: 50, query: "SOL-USDC", sort: "tvl", dir: "desc", hideBlacklisted: true }, signal);
  const rejected: string[] = [];
  const pools: Candidate[] = [];
  for (const p of page.data as ApiPool[]) {
    const exact = p.token_x.address === WSOL_MINT && p.token_y.address === USDC_MINT;
    if (!exact) continue;
    if (p.is_blacklisted) { rejected.push(`${p.address}: blacklisted`); continue; }
    if (pools.some((x) => x.address === p.address)) continue;
    pools.push({ address: p.address, name: p.name ?? "SOL-USDC", binStep: p.pool_config?.bin_step, tvl: p.tvl });
    if (pools.length >= Math.min(max, MAX_POOLS)) break;
  }
  return { pools, rejected };
}

/** On-chain verification: lbPair owned by DLMM, enabled, exact canonical mints, both legacy SPL Token, no hooks. */
export async function verifyPool(connection: Connection, pool: DLMM): Promise<string | null> {
  const acc = await withTimeout(connection.getAccountInfo(pool.pubkey, "confirmed"), 10_000, "Pool account read");
  if (!acc || acc.owner.toBase58() !== DLMM_PROGRAM_ID) return "Pool account is not owned by the DLMM program";
  const x = pool.lbPair.tokenXMint.toBase58(), y = pool.lbPair.tokenYMint.toBase58();
  if (x !== WSOL_MINT || y !== USDC_MINT) return "Pool mints are not exactly WSOL (X) / USDC (Y)";
  if (pool.lbPair.status !== 0) return "Pool is disabled";
  if (pool.tokenX.owner.toBase58() !== SPL_TOKEN_PROGRAM || pool.tokenY.owner.toBase58() !== SPL_TOKEN_PROGRAM) return "Token-2022 or unknown token program — unsupported";
  if (pool.tokenX.transferHookAccountMetas.length || pool.tokenY.transferHookAccountMetas.length) return "Transfer-hook accounts present — unsupported";
  if (pool.tokenX.mint.decimals !== 9 || pool.tokenY.mint.decimals !== 6) return "Unexpected mint decimals";
  return null;
}

/** Mint accounts themselves must be owned by the legacy SPL Token program. */
export async function verifyMints(connection: Connection): Promise<string | null> {
  const { PublicKey } = await import("@solana/web3.js");
  const accs = await withTimeout(connection.getMultipleAccountsInfo([new PublicKey(WSOL_MINT), new PublicKey(USDC_MINT)], "confirmed"), 10_000, "Mint read");
  if (!accs[0] || !accs[1]) return "Mint account missing";
  if (accs[0].owner.toBase58() !== SPL_TOKEN_PROGRAM || accs[1].owner.toBase58() !== SPL_TOKEN_PROGRAM) return "Mint not owned by SPL Token program";
  return null;
}

export interface PoolState { address: string; name: string; binStep?: number; pool: DLMM; error?: undefined }
export interface QuotedLeg extends LegQuote { binArrays: PK[] }

export async function quoteLeg(pool: DLMM, inMint: string, inRaw: BN, slippageBps: number): Promise<QuotedLeg> {
  const swapForY = inMint === WSOL_MINT; // X = WSOL
  const arrays = await withTimeout(pool.getBinArrayForSwap(swapForY, 3), 12_000, "Bin array read");
  // isPartialFill=true lets us detect (and reject) a partial fill rather than throw generically.
  const q = pool.swapQuote(inRaw, swapForY, new BN(slippageBps), arrays, true);
  return {
    pool: pool.pubkey.toBase58(), inMint, outMint: swapForY ? USDC_MINT : WSOL_MINT, requested: inRaw,
    consumed: q.consumedInAmount, out: q.outAmount, min: q.minOutAmount, fee: q.fee, protocolFee: q.protocolFee,
    impactPct: q.priceImpact.toString(), binArrays: q.binArraysPubkey as PK[],
  };
}

export interface RouteResult { a: QuotedLeg; b: QuotedLeg | null; verdict: RouteVerdict; nameA: string; nameB: string }

export interface ScanResult {
  at: number;
  pools: { address: string; name: string; binStep?: number; status: "ok" | "rejected" | "error"; reason?: string }[];
  routes: RouteResult[];
  /** costs assumed for the scan (read-only: wallet-dependent rent unknown when not connected) */
  costs: Costs;
}

/** Bounded concurrency map. */
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) {
      if (signal?.aborted) throw new Error("Scan cancelled");
      const k = i++;
      out[k] = await f(xs[k]!);
    }
  }));
  return out;
}

/** Read-only scan: fresh SDK state + executable swapQuote in both directions for every ordered pool pair. */
export async function scanRoutes(connection: Connection, opts: { inLamports: BN; minProfit: BN; slippageBps: number; maxPools: number; costs: Costs; signal?: AbortSignal; log?: (m: string) => void }): Promise<ScanResult> {
  const { signal, log = () => {} } = opts;
  const mintErr = await verifyMints(connection);
  if (mintErr) throw new Error(mintErr);
  const { pools: cands } = await discoverCandidates(opts.maxPools, signal);
  log(`Discovered ${cands.length} exact WSOL/USDC pools from the Meteora API`);
  if (cands.length < 2) throw new Error("Fewer than two eligible SOL/USDC pools found");
  const states = await mapLimit(cands, 2, async (c) => {
    try {
      invalidatePool(c.address);
      const pool = await withTimeout(getPool(connection, c.address, "mainnet-beta"), 20_000, "SDK pool load");
      await withTimeout(pool.refetchStates(), 15_000, "Pool refresh");
      const bad = await verifyPool(connection, pool);
      return bad ? { c, status: "rejected" as const, reason: bad } : { c, status: "ok" as const, pool };
    } catch (e) {
      return { c, status: "error" as const, reason: e instanceof Error ? e.message : String(e) };
    }
  }, signal);
  const ok = states.filter((s) => s.status === "ok") as { c: Candidate; status: "ok"; pool: DLMM }[];
  // leg A once per pool
  const legA = new Map<string, QuotedLeg | string>();
  await mapLimit(ok, 2, async (s) => {
    try { legA.set(s.c.address, await quoteLeg(s.pool, WSOL_MINT, opts.inLamports, opts.slippageBps)); }
    catch (e) { legA.set(s.c.address, e instanceof Error ? e.message : String(e)); }
  }, signal);
  const pairs: [typeof ok[number], typeof ok[number]][] = [];
  for (const A of ok) for (const B of ok) if (A.c.address !== B.c.address) pairs.push([A, B]);
  const routes = (await mapLimit(pairs, 2, async ([A, B]) => {
    const a = legA.get(A.c.address);
    if (!a || typeof a === "string") return null;
    try {
      if (!a.consumed.eq(a.requested)) return { a, b: null, verdict: { kind: "invalid", reason: "Leg A would be a partial fill" }, nameA: A.c.name, nameB: B.c.name } as RouteResult;
      const b = await quoteLeg(B.pool, USDC_MINT, a.min, opts.slippageBps);
      return { a, b, verdict: evaluateRoute(a, b, opts.minProfit, opts.costs), nameA: label(A.c), nameB: label(B.c) };
    } catch (e) {
      return { a, b: null, verdict: { kind: "invalid", reason: `Leg B quote failed: ${e instanceof Error ? e.message : String(e)}` }, nameA: label(A.c), nameB: label(B.c) } as RouteResult;
    }
  }, signal)).filter((r): r is RouteResult => !!r);
  routes.sort((x, y) => rank(y) - rank(x));
  return {
    at: Date.now(),
    pools: states.map((s) => ({ address: s.c.address, name: label(s.c), binStep: s.c.binStep, status: s.status, reason: s.status === "ok" ? (typeof legA.get(s.c.address) === "string" ? `Leg A quote failed: ${legA.get(s.c.address)}` : undefined) : s.reason })),
    routes,
    costs: opts.costs,
  };
}
const label = (c: Candidate) => `${c.name}${c.binStep ? ` · ${c.binStep}bps` : ""}`;
function rank(r: RouteResult) {
  if (r.verdict.kind === "profitable") return 1e12 + Number(r.verdict.conservativeProfit.toString());
  if (r.verdict.kind === "unprofitable" && r.verdict.expectedProfit) return Number(r.verdict.expectedProfit.toString());
  return -1e15;
}

/* ---------------- atomic transaction composition ---------------- */

export interface WalletAccounts { wsolAta: PK; usdcAta: PK; wsolExists: boolean; usdcExists: boolean; wsolOwnerOk: boolean; usdcOwnerOk: boolean; lamports: BN; ataRent: BN }

export async function readWalletAccounts(connection: Connection, user: PK): Promise<WalletAccounts> {
  const { PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), user, false);
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user, false);
  const [accs, lamports, ataRent] = await Promise.all([
    withTimeout(connection.getMultipleAccountsInfo([wsolAta, usdcAta], "confirmed"), 10_000, "Token account read"),
    withTimeout(connection.getBalance(user, "confirmed"), 10_000, "Balance read"),
    withTimeout(connection.getMinimumBalanceForRentExemption(165, "confirmed"), 10_000, "Rent read"),
  ]);
  const own = (a: typeof accs[number] | undefined) => !a || a.owner.toBase58() === SPL_TOKEN_PROGRAM;
  return { wsolAta, usdcAta, wsolExists: !!accs[0], usdcExists: !!accs[1], wsolOwnerOk: own(accs[0]), usdcOwnerOk: own(accs[1]), lamports: new BN(lamports), ataRent: new BN(ataRent) };
}

/** Wallet-specific cost model. WSOL ATA created here is closed in the same tx (refundable); a new USDC ATA is kept (residual dust lives there). */
export function walletCosts(w: WalletAccounts, priorityBudget: BN, computeUnits: number): Costs & { microLamports: BN } {
  const micro = priorityPrice(priorityBudget, computeUnits);
  return {
    microLamports: micro,
    baseFee: new BN(BASE_FEE_PER_SIGNATURE),
    priorityFee: priorityFeeLamports(micro, computeUnits),
    nonRefundableRent: w.usdcExists ? new BN(0) : w.ataRent,
    refundableRent: w.wsolExists ? new BN(0) : w.ataRent,
  };
}

async function swapIx(pool: DLMM, user: PK, inMint: string, userIn: PK, userOut: PK, inAmount: BN, minOut: BN, binArrays: PK[]): Promise<TransactionInstruction> {
  const { slices, accounts } = pool.getPotentialToken2022IxDataAndAccounts(0);
  if (accounts.length) throw new Error("Transfer-hook accounts are not supported");
  const { PublicKey } = await import("@solana/web3.js");
  void inMint;
  return pool.program.methods.swap2(inAmount, minOut, { slices }).accountsPartial({
    lbPair: pool.pubkey, reserveX: pool.lbPair.reserveX, reserveY: pool.lbPair.reserveY,
    tokenXMint: pool.lbPair.tokenXMint, tokenYMint: pool.lbPair.tokenYMint,
    tokenXProgram: pool.tokenX.owner, tokenYProgram: pool.tokenY.owner,
    user, userTokenIn: userIn, userTokenOut: userOut,
    binArrayBitmapExtension: pool.binArrayBitmapExtension ? pool.binArrayBitmapExtension.publicKey : null,
    oracle: pool.lbPair.oracle, hostFeeIn: null, memoProgram: new PublicKey(ALLOWED_MEMO),
  }).remainingAccounts(binArrays.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).instruction();
}
const ALLOWED_MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export interface BuiltArb { tx: Transaction; bytes: number; programs: string[]; closesWsol: boolean; createsWsol: boolean; createsUsdc: boolean }

/**
 * ONE atomic legacy transaction:
 *  CU limit, CU price, [create WSOL ATA idempotent], [create USDC ATA idempotent],
 *  transfer input lamports -> WSOL ATA, syncNative, swap2 A (WSOL->USDC, min = A.min),
 *  swap2 B (USDC->WSOL, in = A.min, min = enforced floor), [close WSOL ATA only if created here].
 * No unwrap between legs; pre-existing accounts are never closed or drained.
 */
export async function buildArbTx(opts: { user: PK; poolA: DLMM; poolB: DLMM; a: QuotedLeg; b: QuotedLeg; floor: BN; w: WalletAccounts; microLamports: BN; computeUnits: number }): Promise<BuiltArb> {
  const { user, poolA, poolB, a, b, floor, w } = opts;
  if (poolA.pubkey.equals(poolB.pubkey)) throw new Error("Duplicate pool legs");
  if (!b.requested.eq(a.min)) throw new Error("Leg B input must equal leg A minimum output");
  if (b.min.lt(floor)) throw new Error("Leg B minimum is below the enforced floor");
  if (!w.wsolOwnerOk || !w.usdcOwnerOk) throw new Error("A wallet token account is not owned by the SPL Token program");
  const web3 = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  const { ComputeBudgetProgram, SystemProgram, Transaction, PublicKey } = web3;
  const wsol = new PublicKey(WSOL_MINT), usdc = new PublicKey(USDC_MINT);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(opts.microLamports.toString()) }),
  ];
  if (!w.wsolExists) ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(user, w.wsolAta, user, wsol));
  if (!w.usdcExists) ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(user, w.usdcAta, user, usdc));
  ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: w.wsolAta, lamports: BigInt(a.requested.toString()) }));
  ixs.push(spl.createSyncNativeInstruction(w.wsolAta));
  ixs.push(await swapIx(poolA, user, WSOL_MINT, w.wsolAta, w.usdcAta, a.requested, a.min, a.binArrays));
  // floor is >= b.min? no: we enforce the stricter of the two (b.min >= floor checked above)
  ixs.push(await swapIx(poolB, user, USDC_MINT, w.usdcAta, w.wsolAta, b.requested, BN.max(b.min, floor), b.binArrays));
  if (!w.wsolExists) ixs.push(spl.createCloseAccountInstruction(w.wsolAta, user, user));
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = user;
  tx.recentBlockhash = "11111111111111111111111111111111"; // placeholder for size check; runner replaces it
  const programs = [...new Set(ixs.map((i) => i.programId.toBase58()))];
  const bad = programs.filter((p) => !ALLOWED_PROGRAMS.has(p));
  if (bad.length) throw new Error(`Unexpected program in transaction: ${bad.join(", ")}`);
  let bytes: number;
  try { bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length; }
  catch (e) { throw new Error(`Route cannot fit in one transaction: ${e instanceof Error ? e.message : String(e)}`); }
  if (bytes > MAX_TX_BYTES) throw new Error(`Route cannot fit atomically: ${bytes} bytes > ${MAX_TX_BYTES}`);
  return { tx, bytes, programs, closesWsol: !w.wsolExists, createsWsol: !w.wsolExists, createsUsdc: !w.usdcExists };
}

export { evaluateRoute };

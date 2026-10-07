import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { MINT_SIZE, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { JobControl } from "@/lib/job-control";
import { buildNativeRebalance, buildWithdraw } from "@/lib/agents-chain";
import { executionReadiness, REVIEW_TTL_MS } from "@/lib/agents";
import { GENESIS, checkSignature, runTransaction, type PendingStore, type PendingTx } from "@/lib/tx";
import { createRpcFetch } from "@/lib/rpc-fetch";

vi.mock("@/lib/dlmm", () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const sdk = require("@meteora-ag/dlmm");
  return { loadSdk: async () => ({ ...sdk, default: sdk.default ?? sdk }) };
});
const require = createRequire(new URL("../../package.json", import.meta.url));
const sdk = require("@meteora-ag/dlmm");
const DLMM = sdk.default ?? sdk;
// This script can only run on devnet. There is no mainnet URL/configuration option.
const DEVNET_RPC = "https://api.devnet.solana.com";
const REQUIRED_SOL = 350_000_000;
const WALLET_FILE = ".qa/funded-devnet-wallet.json";

describe("explicit funded DEVNET acceptance", () => {
  it("confirms odd/even native moves, a 25% withdrawal and cleanup through the real wallet runner", async () => {
    const report: Record<string, unknown> = { at: new Date().toISOString(), network: "devnet", rpc: DEVNET_RPC, realMainnetFunds: false, passed: false, operations: [] };
    const operations = report.operations as Record<string, unknown>[];
    const connection = new Connection(DEVNET_RPC, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: createRpcFetch() });
    const pendingFile = ".qa/devnet-pending.json";
    const loadPending = (): PendingTx[] => existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, "utf8")) : [];
    const savePending = (rows: PendingTx[]) => { mkdirSync(".qa", { recursive: true, mode: 0o700 }); writeFileSync(pendingFile, JSON.stringify(rows), { mode: 0o600 }); };
    const store: PendingStore = { list: loadPending, put: (p) => savePending([p, ...loadPending().filter((x) => x.signature !== p.signature)]), remove: (s) => savePending(loadPending().filter((p) => p.signature !== s)) };
    const control = new JobControl();
    try {
      expect(await connection.getGenesisHash()).toBe(GENESIS.devnet);
      const program = await connection.getAccountInfo(new PublicKey(sdk.LBCLMM_PROGRAM_IDS.devnet));
      if (!program?.executable) throw new Error("The Meteora DLMM program is not executable on devnet.");
      mkdirSync(".qa", { recursive: true, mode: 0o700 });
      let payer: Keypair;
      if (existsSync(WALLET_FILE)) {
        const saved = JSON.parse(readFileSync(WALLET_FILE, "utf8"));
        if (saved.network !== "devnet" || saved.purpose !== "Studio Loco acceptance") throw new Error("Refusing to load a wallet outside this dedicated devnet QA session.");
        payer = Keypair.fromSecretKey(Uint8Array.from(saved.secretKey));
      } else {
        payer = Keypair.generate();
        writeFileSync(WALLET_FILE, JSON.stringify({ network: "devnet", purpose: "Studio Loco acceptance", secretKey: [...payer.secretKey] }), { mode: 0o600 });
      }
      report.wallet = payer.publicKey.toBase58();
      let balance = await connection.getBalance(payer.publicKey);
      if (balance < REQUIRED_SOL && process.env["LOCO_QA_REQUEST_FAUCET"] === "1") {
        // One explicit faucet attempt only. A 429 is never retried or bypassed.
        const signature = await connection.requestAirdrop(payer.publicKey, 500_000_000);
        operations.push({ label: "Devnet faucet", signature });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        balance = await connection.getBalance(payer.publicKey);
      }
      report.initialBalanceLamports = balance;
      if (balance < REQUIRED_SOL) {
        report.blocked = "devnet-funding-required";
        throw new Error(`Fund this dedicated wallet with 0.5 DEVNET SOL using https://faucet.solana.com, then rerun: ${payer.publicKey.toBase58()}. Nothing was signed.`);
      }
      for (const pending of store.list()) {
        if (pending.cluster !== "devnet" || pending.wallet !== payer.publicKey.toBase58()) throw new Error("A pending record belongs to another QA identity; review it manually.");
        const status = await checkSignature(connection, pending.signature, pending.lastValidBlockHeight);
        if (status.kind === "confirmed" || status.kind === "expired") store.remove(pending.signature);
        else throw new Error(`Previous settlement is unresolved: ${pending.signature}. Nothing will be resent.`);
      }
      const wallet = { publicKey: payer.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(payer); return tx; } };
      const send = async (label: string, tx: Transaction, signers: Keypair[] = [], costs?: Parameters<typeof executionReadiness>[0]) => {
        if (store.list().length) throw new Error("Unresolved settlement blocks this QA session.");
        const builtAt = Date.now();
        const guard = () => costs ? (Date.now() - builtAt > REVIEW_TTL_MS ? "QA review expired; rebuild it." : executionReadiness(costs, store.list().length > 0)) : null;
        const result = await runTransaction({ connection, wallet, tx, signers, label, ctx: { cluster: "devnet", rpc: "public", store, semanticGuard: guard, maxFeeLamports: costs?.perTxFee[0] ?? undefined }, pollMs: 1000, maxWaitMs: 90_000 });
        const landed = await connection.getTransaction(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        expect(landed?.meta?.err).toBeNull();
        operations.push({ label, signature: result.signature, slot: result.slot, confirmed: true, feeLamports: landed!.meta!.fee });
        console.log(JSON.stringify(operations.at(-1)));
        return result;
      };
      // Synthetic test token + a WSOL account; all account creation goes through the shared runner.
      const mint = Keypair.generate();
      const tokenAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey);
      const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
      const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      const setup = new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint.publicKey, 9, payer.publicKey, null),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tokenAta, payer.publicKey, mint.publicKey),
        createMintToInstruction(mint.publicKey, tokenAta, payer.publicKey, 1_000_000_000_000n),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, payer.publicKey, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports: 40_000_000 }),
        createSyncNativeInstruction(wsolAta),
      );
      await send("Create synthetic devnet token and wrap test SOL", setup, [mint]);
      const pairTx = await DLMM.createCustomizablePermissionlessLbPair2(connection, new BN(25), NATIVE_MINT, mint.publicKey, new BN(0), new BN(10), sdk.ActivationType.Slot, false, payer.publicKey, undefined, false, sdk.ConcreteFunctionType.LiquidityMining, sdk.CollectFeeMode.InputOnly, { cluster: "devnet" });
      await send("Create isolated test pool", pairTx);
      const [pair] = sdk.deriveCustomizablePermissionlessLbPair(NATIVE_MINT, mint.publicKey, new PublicKey(sdk.LBCLMM_PROGRAM_IDS.devnet));
      report.pool = pair.toBase58();
      const loadPool = () => DLMM.create(connection, pair, { cluster: "devnet", skipSolWrappingOperation: true });
      for (const width of [20, 21]) for (const strategy of ["Spot", "Curve", "BidAsk"] as const) {
        let pool = await loadPool();
        const position = Keypair.generate();
        const nativeIsX = pool.tokenX.publicKey.equals(NATIVE_MINT);
        const active = pool.lbPair.activeId;
        const lower = nativeIsX ? active + 2 : active - width - 1;
        const upper = lower + width - 1;
        const add = await pool.initializePositionAndAddLiquidityByStrategy({ positionPubKey: position.publicKey, user: payer.publicKey,
          totalXAmount: new BN(nativeIsX ? 10_000_000 : 0), totalYAmount: new BN(nativeIsX ? 0 : 10_000_000),
          strategy: { minBinId: lower, maxBinId: upper, strategyType: sdk.StrategyType.Spot }, slippage: 0.5 });
        await send(`Create funded ${width}-bin out-of-range position (${strategy})`, add, [position]);
        const job = control.begin();
        if (!job) throw new Error("QA SDK work is still draining.");
        let built;
        try { built = await buildNativeRebalance({ connection, owner: payer.publicKey, poolAddress: pair.toBase58(), position: position.publicKey.toBase58(), strategy, slippageBps: 50, cluster: "devnet", job }); }
        finally { control.end(job); }
        if (!built.ok) throw new Error(`Native ${width}-bin build refused: ${built.reason}`);
        if (built.built.kind !== "atomic") throw new Error("This funded acceptance expects one native transaction.");
        await send(`Native ${width}-bin ${strategy} rebalance`, built.built.txs[0]!.tx, [], built.built.costs);
        pool = await loadPool();
        let pd = (await pool.getPosition(position.publicKey)).positionData;
        expect({ lower: pd.lowerBinId, upper: pd.upperBinId }).toEqual(built.built.target);
        expect(pd.upperBinId - pd.lowerBinId + 1).toBe(width);
        expect(pd.owner.equals(payer.publicKey)).toBe(true);
        const beforeAccount = await connection.getAccountInfo(position.publicKey);
        if (!beforeAccount) throw new Error("Confirmed native position is missing.");
        const before = sdk.wrapPosition(pool.program, position.publicKey, beforeAccount).liquidityShares() as BN[];
        const wjob = control.begin();
        if (!wjob) throw new Error("QA SDK work is still draining.");
        let withdrawal;
        try { withdrawal = await buildWithdraw({ connection, owner: payer.publicKey, poolAddress: pair.toBase58(), position: position.publicKey.toBase58(), bps: 2500, cluster: "devnet", label: "QA 25% withdrawal", job: wjob }); }
        finally { control.end(wjob); }
        await send(`${width}-bin ${strategy} partial withdrawal (25%)`, withdrawal.txs[0]!.tx, [], withdrawal.costs);
        const afterAccount = await connection.getAccountInfo(position.publicKey);
        if (!afterAccount) throw new Error("A partial withdrawal unexpectedly closed the position.");
        const after = sdk.wrapPosition(pool.program, position.publicKey, afterAccount).liquidityShares() as BN[];
        expect(after).toHaveLength(before.length);
        for (let i = 0; i < before.length; i++) expect(after[i]!.eq(before[i]!.sub(before[i]!.muln(2500).divn(10_000)))).toBe(true);
        expect(await connection.getAccountInfo(wsolAta)).not.toBeNull();
        operations.push({ label: `${width}-bin ${strategy} post-state`, position: position.publicKey.toBase58(), sameWidth: true, target: built.built.target, exactPartialWithdrawal: true, existingWsolPreserved: true });
        // Cleanup is explicit and confirmed. No silent follow-on action exists in the product.
        pool = await loadPool(); pd = (await pool.getPosition(position.publicKey)).positionData;
        const cleanup = await pool.removeLiquidity({ user: payer.publicKey, position: position.publicKey, fromBinId: pd.lowerBinId, toBinId: pd.upperBinId, bps: new BN(10_000), shouldClaimAndClose: true, skipUnwrapSOL: true });
        for (const tx of cleanup) await send(`${width}-bin ${strategy} cleanup: withdraw remaining shares and close`, tx);
        expect(await connection.getAccountInfo(position.publicKey)).toBeNull();
        expect(await connection.getAccountInfo(wsolAta)).not.toBeNull();
      }
      report.finalBalanceLamports = await connection.getBalance(payer.publicKey);
      report.unresolvedSignatures = store.list();
      expect(store.list()).toHaveLength(0);
      report.passed = true;
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
      report.unresolvedSignatures = store.list();
      throw e;
    } finally {
      mkdirSync("docs/qa", { recursive: true });
      writeFileSync("docs/qa/funded-devnet-acceptance.json", JSON.stringify(report, null, 2) + "\n");
    }
  });
});

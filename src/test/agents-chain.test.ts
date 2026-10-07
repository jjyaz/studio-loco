// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { Buffer } from "buffer";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { JobControl, JobTimeout } from "@/lib/job-control";
import { buildNativeRebalance, buildWithdraw, newAccountRentLamports, reviewCosts, verifyStagedDestination } from "@/lib/agents-chain";

const mocked = vi.hoisted(() => ({ create: vi.fn(), parameters: vi.fn(() => ({ x0: new BN(1), y0: new BN(1), deltaX: new BN(0), deltaY: new BN(0) })) }));
vi.mock("@/lib/dlmm", () => ({ loadSdk: async () => ({ default: { create: mocked.create }, buildLiquidityStrategyParameters: mocked.parameters, getLiquidityStrategyParameterBuilder: vi.fn() }) }));
const owner = Keypair.generate().publicKey, poolAddress = Keypair.generate().publicKey.toBase58();
const position = Keypair.generate().publicKey.toBase58();
const mintX = "So11111111111111111111111111111111111111112", mintY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const blockhash = "11111111111111111111111111111111";
const tx = () => new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight: 1 }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 0 }));
const connection = () => ({
  getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 1 })),
  getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => k.equals(owner) ? { lamports: 10_000_000 } : null)),
  getFeeForMessage: vi.fn(async () => ({ value: 5000 })),
  simulateTransaction: vi.fn(async (_tx, config) => ({ value: { err: null, logs: [], unitsConsumed: 50_000, accounts: config.accounts.addresses.map((a: string) => a === owner.toBase58() ? { lamports: 9_995_000, owner: SystemProgram.programId.toBase58(), data: ["", "base64"] } : null) } })),
});
const pool = () => ({
  lbPair: { activeId: 100, binStep: 25 },
  tokenX: { publicKey: new PublicKey(mintX) }, tokenY: { publicKey: new PublicKey(mintY) },
  getPosition: vi.fn(async () => ({ positionData: { owner, lowerBinId: 90, upperBinId: 110, totalXAmount: "1000", totalYAmount: "1000", feeX: new BN(0), feeY: new BN(0) } })),
  removeLiquidity: vi.fn(async (_args: unknown) => [tx()]),
  simulateRebalancePosition: vi.fn(async (..._args: unknown[]) => ({ rebalancePosition: { lbPair: { activeId: 100 } }, binArrayCost: 0.00203928, bitmapExtensionCost: 0, binArrayCount: 0, simulationResult: {
    // Real SDK offsets are NUMBERS, not BN. Actual deposits are net wallet top-ups.
    depositParams: [{ minDeltaId: -10, maxDeltaId: 10 }], actualAmountXDeposited: new BN(0), actualAmountYDeposited: new BN(0),
    amountXDeposited: new BN(997), amountYDeposited: new BN(998), actualAmountXWithdrawn: new BN(3), actualAmountYWithdrawn: new BN(2),
  } })),
  rebalancePosition: vi.fn(async () => ({ initBinArrayInstructions: [], rebalancePositionInstruction: tx().instructions })),
});
afterEach(() => { vi.useRealTimers(); mocked.create.mockReset(); mocked.parameters.mockClear(); });

describe("chain review and SDK boundaries", () => {
  it("builds numeric SDK offsets, shows gross redeposit separately and preserves WSOL", async () => {
    const p = pool(); mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    const result = await buildNativeRebalance({ connection: connection() as never, owner, poolAddress, position, strategy: "Spot", slippageBps: 50, cluster: "mainnet-beta", job });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.built.deposited).toEqual({ x: "997", y: "998" });
      expect(result.built.walletOut).toEqual({ x: "3", y: "2" });
      expect(result.built.withdrawn).toEqual({ x: "1000", y: "1000" });
    }
    expect(mocked.create.mock.calls[0]?.[2]).toEqual({ cluster: "mainnet-beta", skipSolWrappingOperation: true });
    c.end(job);
  });
  it("rejects a small net top-up even when the position's gross holdings exceed it", async () => {
    const p = pool(), response = await p.simulateRebalancePosition();
    response.simulationResult.actualAmountXDeposited = new BN(1);
    p.simulateRebalancePosition.mockResolvedValue(response); mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    const result = await buildNativeRebalance({ connection: connection() as never, owner, poolAddress, position, strategy: "Spot", slippageBps: 50, cluster: "mainnet-beta", job });
    expect(result.ok).toBe(false);
    expect(p.rebalancePosition).not.toHaveBeenCalled(); c.end(job);
  });
  it("passes an exact even-width range to the SDK's explicit native strategy", async () => {
    const p = pool();
    const pd = (await p.getPosition()).positionData;
    pd.upperBinId = 109; p.getPosition.mockResolvedValue({ positionData: pd });
    const response = await p.simulateRebalancePosition();
    response.simulationResult.depositParams = [{ minDeltaId: -10, maxDeltaId: 9 }];
    p.simulateRebalancePosition.mockResolvedValue(response); mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    const result = await buildNativeRebalance({ connection: connection() as never, owner, poolAddress, position, strategy: "Spot", slippageBps: 50, cluster: "mainnet-beta", job });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.built.target).toEqual({ lower: 90, upper: 109 });
    const args = p.simulateRebalancePosition.mock.calls.at(-1)!;
    const deposits = args[4] as { minDeltaId: BN; maxDeltaId: BN }[];
    expect(deposits[0]!.minDeltaId.toNumber()).toBe(-10);
    expect(deposits[0]!.maxDeltaId.toNumber()).toBe(9);
    c.end(job);
  });
  it("refuses a moving active-bin snapshot before building an instruction", async () => {
    const p = pool(), response = await p.simulateRebalancePosition();
    response.rebalancePosition.lbPair.activeId = 101;
    p.simulateRebalancePosition.mockResolvedValue(response); mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    const result = await buildNativeRebalance({ connection: connection() as never, owner, poolAddress, position, strategy: "Spot", slippageBps: 50, cluster: "mainnet-beta", job });
    expect(result.ok).toBe(false); expect(p.rebalancePosition).not.toHaveBeenCalled(); c.end(job);
  });
  it("refuses a rebalance that would redeposit nothing", async () => {
    const p = pool(), response = await p.simulateRebalancePosition();
    response.simulationResult.amountXDeposited = new BN(0); response.simulationResult.amountYDeposited = new BN(0);
    p.simulateRebalancePosition.mockResolvedValue(response); mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    const result = await buildNativeRebalance({ connection: connection() as never, owner, poolAddress, position, strategy: "Spot", slippageBps: 50, cluster: "mainnet-beta", job });
    expect(result.ok).toBe(false); expect(p.rebalancePosition).not.toHaveBeenCalled(); c.end(job);
  });
  it("blocks a multi-transaction percentage withdrawal before simulation or signing", async () => {
    const p = pool(); p.removeLiquidity.mockResolvedValue([tx(), tx()]); mocked.create.mockResolvedValue(p);
    const rpc = connection(), c = new JobControl(), job = c.begin()!;
    await expect(buildWithdraw({ connection: rpc as never, owner, poolAddress, position, bps: 5000, cluster: "mainnet-beta", label: "Withdraw 50%", job })).rejects.toThrow(/single-transaction/);
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
    expect(p.removeLiquidity.mock.calls[0]?.[0]).toMatchObject({ skipUnwrapSOL: true, shouldClaimAndClose: false }); c.end(job);
  });
  it("refuses a destination whose real mint pair differs from its API label", async () => {
    const p = pool(); p.tokenY.publicKey = Keypair.generate().publicKey; mocked.create.mockResolvedValue(p);
    const c = new JobControl(), job = c.begin()!;
    await expect(verifyStagedDestination({ connection: connection() as never, poolAddress, mintX, mintY, cluster: "mainnet-beta", job })).rejects.toThrow(/same two mint/); c.end(job);
  });
  it("does not double-charge the simulated fee", async () => {
    const c = new JobControl(), job = c.begin()!;
    const result = await reviewCosts(connection() as never, owner, [tx()], job);
    expect(result.solOutLamports).toBe(5000); expect(result.requiredLamports).toBe(5000); c.end(job);
  });
  it("does not let account refunds hide upfront rent", async () => {
    const rpc = connection(), account = Keypair.generate().publicKey;
    const create = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight: 1 }).add(SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: account, lamports: 2_000_000, space: 0, programId: SystemProgram.programId }));
    rpc.simulateTransaction.mockImplementation(async (_tx, config) => ({ value: { err: null, logs: [], unitsConsumed: 50_000, accounts: config.accounts.addresses.map((a: string) => ({ lamports: a === owner.toBase58() ? 9_999_000 : 2_000_000, owner: SystemProgram.programId.toBase58(), data: ["", "base64"] })) } }));
    const c = new JobControl(), job = c.begin()!;
    const result = await reviewCosts(rpc as never, owner, [create], job);
    expect(result.solOutLamports).toBe(1000); expect(result.requiredLamports).toBe(2_005_000); c.end(job);
  });
  it("counts only the rent reserve of a new WSOL account, not withdrawn SOL", () => {
    const data = Buffer.alloc(165); data.writeUInt32LE(1, 109); data.writeBigUInt64LE(2_039_280n, 113);
    expect(newAccountRentLamports({ lamports: 1_002_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [data.toString("base64"), "base64"] })).toBe(2_039_280);
  });
  it("holds the drain latch until the original timed-out RPC settles", async () => {
    vi.useFakeTimers();
    let resolve!: (r: { lamports: number }[]) => void;
    const pending = new Promise<{ lamports: number }[]>((r) => { resolve = r; });
    const rpc = connection(); rpc.getMultipleAccountsInfo.mockReturnValue(pending);
    const c = new JobControl(), job = c.begin()!;
    const work = reviewCosts(rpc as never, owner, [tx()], job);
    const rejected = expect(work).rejects.toBeInstanceOf(JobTimeout);
    await vi.advanceTimersByTimeAsync(12_001); await rejected; c.end(job);
    expect(c.draining).toBe(true); expect(c.begin()).toBeNull();
    resolve([{ lamports: 10_000_000 }]); await pending; await Promise.resolve();
    expect(c.draining).toBe(false);
  });
});

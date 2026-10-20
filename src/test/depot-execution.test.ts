// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { bindingKey, getPreset, launchMath, reviewGuard, tokenGate, validateRecipients, type ReviewBinding } from "@/lib/depot";
import { depotActionGuard, depotInstructionKey, type PreparedDepotAction } from "@/lib/depot-chain";
vi.mock("@/lib/depot-chain", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/depot-chain")>(), checkDepotFreshCosts: vi.fn(async () => {}) }));

const OWNER = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD";
const OTHER = "So11111111111111111111111111111111111111112";
const binding = (): ReviewBinding => ({ wallet: OWNER, cluster: "mainnet-beta", rpc: "public", rpcGeneration: 4, agentId: "a-test-agent", agentRevision: 1, presetId: "standard-sol-85", presetVersion: 1, metadataUri: "https://studioloco.cfd/api/depot/m/abc", metadataHash: "a".repeat(64), recipients: [], maxStageLamports: 100_000_000n, maxTotalLamports: 100_000_000n });
function prepared(): PreparedDepotAction {
  const b = binding(), tx = new Transaction({ feePayer: new PublicKey(OWNER), recentBlockhash: OTHER }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(OWNER), toPubkey: new PublicKey(OTHER), lamports: 5n }));
  return { kind: "launch", label: "Test only", target: { config: OTHER, mint: OTHER, pool: OTHER }, binding: b, review: { key: bindingKey(b), createdAt: Date.now(), stages: [{ label: "atomic", feeLamports: 5000n, rentLamports: 1n }] }, tx, signers: [], instructionKey: depotInstructionKey(tx), observedSlot: 1, notes: [] };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

describe("Depot execution boundaries", () => {
  it("includes protocol fees and splits the remaining share without rounding", () => {
    const m = launchMath({ ...getPreset("small-sol-20", 1), creatorFeeShareBps: 5000 });
    expect([m.protocolFeeBps, m.creatorFeeBps, m.partnerFeeBps]).toEqual([20, 40, 40]);
    expect(launchMath({ ...getPreset("small-sol-20", 1), tradingFeeBps: 1, creatorFeeShareBps: 1250 }).creatorFeeBps).toBe(0.1);
  });
  it("rejects syntactically base58-looking keys of the wrong decoded length", () => {
    expect(validateRecipients("1".repeat(44), [], launchMath(getPreset("small-sol-20", 1)))).toContain("Invalid owner wallet");
  });
  it("binds endpoint generation, metadata digest and spend caps before/after signing", () => {
    const p = prepared();
    for (const b of [{ ...p.binding, rpcGeneration: 5 }, { ...p.binding, metadataHash: "b".repeat(64) }, { ...p.binding, maxStageLamports: 200_000_000n }, { ...p.binding, operationIntent: '{"reserveTo":"changed","reserveSol":"1"}' }]) expect(depotActionGuard(p, b, p.tx)).toMatch(/changed/);
    p.tx.instructions[0]!.keys[1]!.pubkey = new PublicKey(OWNER);
    expect(depotActionGuard(p, p.binding, p.tx)).toMatch(/instructions changed/);
  });
  it("rejects future reviews, empty stages, negative costs and a second cap binding", () => {
    const p = prepared(), now = Date.now();
    expect(reviewGuard({ ...p.review, createdAt: now + 1 }, p.binding, now, p.binding)).toMatch(/expired/);
    expect(reviewGuard({ ...p.review, stages: [] }, p.binding, now, p.binding)).toMatch(/required/);
    expect(reviewGuard({ ...p.review, stages: [{ label: "x", feeLamports: -1n, rentLamports: 0n }] }, p.binding, now, p.binding)).toMatch(/negative/);
    expect(reviewGuard(p.review, p.binding, now, { ...p.binding, maxTotalLamports: 500_000_000n })).toMatch(/changed/);
  });
  it("rejects future holder reads and invalid zero thresholds", () => {
    const p = { mode: "holders" as const, mint: OTHER, minRaw: 1n, maxAgeMs: 1000 };
    expect(tokenGate(p, { mint: OTHER, rawBalance: 2n, readAt: 10, walletVerified: true }, 9).allowed).toBe(false);
    expect(tokenGate({ ...p, minRaw: 0n }, { mint: OTHER, rawBalance: 2n, readAt: 9, walletVerified: true }, 9).allowed).toBe(false);
  });
  it("does not count a new reserve wallet's transferred principal twice as rent", async () => {
    const { depotCosts } = await import("@/lib/depot-chain");
    const p = prepared();
    const result = await depotCosts({
      getMultipleAccountsInfo: async () => [null],
      getFeeForMessage: async () => ({ value: 5000 }),
      simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, accounts: [{ lamports: 5 }], unitsConsumed: 10 } }),
    } as never, p.tx, OWNER);
    expect(result).toMatchObject({ feeLamports: 5000n, rentLamports: 0n });
  });
});

describe("Depot durable operation recovery", () => {
  it("allows only one concurrent reservation across separate tab connections", async () => {
    const a = await import("@/lib/depot-operations");
    vi.resetModules();
    const b = await import("@/lib/depot-operations");
    const results = await Promise.allSettled([a.reserveDepotOperation(prepared()), b.reserveDepotOperation(prepared())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await a.listDepotOperations()).toHaveLength(1);
  });
  it("persists signature/message before broadcast and retains unknown after reload", async () => {
    const a = await import("@/lib/depot-operations");
    const p = prepared(); let id = "";
    const guard = a.depotPolicyGuard({ connection: {} as never, prepared: p, current: () => p.binding, reserved: x => { id = x; } });
    await guard.beforeSign(p.tx, p.tx.serializeMessage());
    const pending = { signature: "sig", blockhash: OTHER, lastValidBlockHeight: 90, wallet: OWNER, cluster: "mainnet-beta", rpc: "public" as const, label: "Test", createdAt: Date.now() };
    await guard.beforeBroadcast(p.tx, p.tx.serializeMessage(), pending);
    await a.settleDepotOperation(id, { label: "Test", phase: "unknown", pending });
    vi.resetModules();
    const b = await import("@/lib/depot-operations");
    const rows = await b.listDepotOperations();
    expect(rows[0]?.state).toBe("unknown");
    expect(rows[0]?.pending?.signature).toBe("sig");
    expect(rows[0]?.signedMessageDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.launchIntent).toEqual({ metadataDigest: "a".repeat(64), presetId: p.binding.presetId, presetVersion: p.binding.presetVersion });
    await expect(b.releaseUnsignedDepotOperation(id)).rejects.toThrow(/Signed evidence/);
    await expect(b.reserveDepotOperation(prepared())).rejects.toThrow(/unresolved/);
  });
  it("can release a never-signed reservation, with no silent deletion", async () => {
    const a = await import("@/lib/depot-operations");
    const id = await a.reserveDepotOperation(prepared());
    await a.releaseUnsignedDepotOperation(id);
    expect((await a.listDepotOperations())[0]?.state).toBe("cancelled");
    await expect(a.reserveDepotOperation(prepared())).resolves.toBeTypeOf("string");
  });
  it("rechecks fresh costs after wallet approval and refuses before recording broadcast permission", async () => {
    const a = await import("@/lib/depot-operations");
    const chain = await import("@/lib/depot-chain");
    const p = prepared(); let id = "";
    const guard = a.depotPolicyGuard({ connection: {} as never, prepared: p, current: () => p.binding, reserved: x => { id = x; } });
    await guard.beforeSign(p.tx, p.tx.serializeMessage());
    vi.mocked(chain.checkDepotFreshCosts).mockRejectedValueOnce(new Error("Costs increased"));
    const pending = { signature: "sig", blockhash: OTHER, lastValidBlockHeight: 90, wallet: OWNER, cluster: "mainnet-beta", rpc: "public" as const, label: "Test", createdAt: Date.now() };
    await expect(guard.beforeBroadcast(p.tx, p.tx.serializeMessage(), pending)).rejects.toThrow(/Costs increased/);
    const row = (await a.listDepotOperations()).find(r => r.id === id)!;
    expect(row.state).toBe("reserved");
    expect(row.pending).toBeUndefined();
    expect(chain.checkDepotFreshCosts).toHaveBeenCalledTimes(2);
  });
  it("refuses signing when durable storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const a = await import("@/lib/depot-operations");
    await expect(a.reserveDepotOperation(prepared())).rejects.toThrow(/Durable device storage/);
  });
});

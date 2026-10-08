// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { GENESIS, memoryPendingStore, runTransaction } from "@/lib/tx";
import { buildArbTx, messageFee, type QuotedLeg, type WalletAccounts } from "@/lib/arb";
import { DLMM_PROGRAM_ID } from "@/lib/dlmm";
import { USDC_MINT, WSOL_MINT, realizedDeltas } from "@/lib/arb-math";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (x: unknown) => x as any;
const payer = Keypair.generate();

function conn(o: { fee?: number | null; feeThrows?: boolean; simErr?: unknown } = {}) {
  return {
    getGenesisHash: vi.fn().mockResolvedValue(GENESIS["devnet"]),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getFeeForMessage: vi.fn(async () => { if (o.feeThrows) throw new Error("rpc down"); return { value: o.fee === undefined ? 5000 : o.fee }; }),
    simulateTransaction: vi.fn(async () => ({ value: { err: o.simErr ?? null, logs: [] } })),
    sendRawTransaction: vi.fn(async () => "sig"),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ slot: 5, confirmationStatus: "confirmed", err: null }] })),
    getBlockHeight: vi.fn().mockResolvedValue(50),
  };
}
const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
const signer = (during?: () => void) => ({
  publicKey: payer.publicKey,
  signTransaction: vi.fn(async (t: Transaction) => { during?.(); t.partialSign(payer); return t; }),
});
const ctx = (extra: object = {}) => ({ cluster: "devnet", rpc: "relay" as const, store: memoryPendingStore(), ...extra });

describe("runner semantic guard + fee cap", () => {
  it("a hosted rule revision changed during wallet approval discards signed bytes", async () => {
    let revision = 1; const c = conn(), store = memoryPendingStore();
    const fresh = vi.fn(async () => revision === 1 ? null : "Private watch changed");
    const w = signer(() => { revision = 2; });
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: tx(), ctx: { ...ctx(), store, asyncSemanticGuard: fresh } })).rejects.toThrow(/Private watch changed/);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(c.sendRawTransaction).not.toHaveBeenCalled(); expect(store.list()).toEqual([]);
  });
  it("unavailable private-rule verification prevents wallet signing", async () => {
    const c = conn(), w = signer();
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: tx(), ctx: ctx({ asyncSemanticGuard: async () => { throw new Error("Watch verification unavailable"); } }) })).rejects.toThrow(/verification unavailable/);
    expect(w.signTransaction).not.toHaveBeenCalled(); expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("quote expiring during wallet approval discards the signed tx (no broadcast, nothing persisted)", async () => {
    let now = 0; const quotedAt = 0;
    const c = conn(); const store = memoryPendingStore();
    const w = signer(() => { now = 25_000; });
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: tx(), ctx: { ...ctx(), store, semanticGuard: () => (now - quotedAt > 20_000 ? "Quote expired" : null) } })).rejects.toThrow(/expired/);
    expect(w.signTransaction).toHaveBeenCalledTimes(1);
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(0);
  });
  it("config change-away-and-back (ABA) still blocks: monotonic generation", async () => {
    let gen = 1; const reviewed = 1; let cfg = "A";
    const c = conn();
    const w = signer(() => { cfg = "B"; gen++; cfg = "A"; gen++; });
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: tx(), ctx: ctx({ semanticGuard: () => (gen !== reviewed ? "changed" : cfg === "A" ? null : "cfg") }) })).rejects.toThrow(/changed/);
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("practice mode turned on during approval blocks broadcast", async () => {
    let practice = false; const c = conn();
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(signer(() => { practice = true; })), tx: tx(), ctx: ctx({ semanticGuard: () => (practice ? "practice" : null) }) })).rejects.toThrow(/practice/);
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("guard failing before signing never opens the wallet", async () => {
    const w = signer();
    await expect(runTransaction({ connection: asAny(conn()), wallet: asAny(w), tx: tx(), ctx: ctx({ semanticGuard: () => "stale" }) })).rejects.toThrow(/stale/);
    expect(w.signTransaction).not.toHaveBeenCalled();
  });
  it("fee rising above the reviewed cap, null fee, or fee RPC error blocks before signing", async () => {
    for (const c of [conn({ fee: 6000 }), conn({ fee: null }), conn({ feeThrows: true })]) {
      const w = signer();
      await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: tx(), ctx: ctx({ maxFeeLamports: 5000 }) })).rejects.toThrow(/fee/i);
      expect(w.signTransaction).not.toHaveBeenCalled();
    }
  });
  it("fee within cap + passing guard confirms", async () => {
    const r = await runTransaction({ connection: asAny(conn({ fee: 5000 })), wallet: asAny(signer()), tx: tx(), ctx: ctx({ maxFeeLamports: 5000, semanticGuard: () => null }) });
    expect(r.signature.length).toBeGreaterThan(40);
  });
  it("simulation failure and wallet rejection never broadcast", async () => {
    const c1 = conn({ simErr: { InstructionError: [4, { Custom: 6003 }] } }); const w1 = signer();
    await expect(runTransaction({ connection: asAny(c1), wallet: asAny(w1), tx: tx(), ctx: ctx({ maxFeeLamports: 5000 }) })).rejects.toMatchObject({ phase: "simulating" });
    expect(w1.signTransaction).not.toHaveBeenCalled();
    const c2 = conn();
    const w2 = { publicKey: payer.publicKey, signTransaction: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) };
    await expect(runTransaction({ connection: asAny(c2), wallet: asAny(w2), tx: tx(), ctx: ctx() })).rejects.toMatchObject({ phase: "rejected" });
    expect(c2.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("messageFee returns null (unknown) on RPC null or error, never 0", async () => {
    expect(await messageFee(asAny(conn({ fee: null })), tx())).toBeNull();
    expect(await messageFee(asAny(conn({ feeThrows: true })), tx())).toBeNull();
    const t7 = tx(); t7.feePayer = payer.publicKey;
    expect((await messageFee(asAny(conn({ fee: 7000 })), t7))?.toString()).toBe("7000");
  });
});

/* ---------------- composition ---------------- */
const user = payer.publicKey;
function mockPool(id: PublicKey, xMint: string, yMint: string) {
  return asAny({
    pubkey: id,
    lbPair: { reserveX: Keypair.generate().publicKey, reserveY: Keypair.generate().publicKey, tokenXMint: new PublicKey(xMint), tokenYMint: new PublicKey(yMint), oracle: Keypair.generate().publicKey },
    tokenX: { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }, tokenY: { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
    binArrayBitmapExtension: null,
    getPotentialToken2022IxDataAndAccounts: () => ({ slices: [], accounts: [] }),
    program: { methods: { swap2: (inAmt: BN, minOut: BN) => {
      let acc: Record<string, PublicKey | null> = {}; let rem: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
      const chain = { accountsPartial: (a: Record<string, PublicKey | null>) => { acc = a; return chain; }, remainingAccounts: (r: typeof rem) => { rem = r; return chain; },
        instruction: async () => new TransactionInstruction({ programId: new PublicKey(DLMM_PROGRAM_ID), keys: [acc["userTokenIn"]!, acc["userTokenOut"]!].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })).concat(rem),
          data: Buffer.concat([inAmt.toArrayLike(Buffer, "le", 8), minOut.toArrayLike(Buffer, "le", 8)]) }) };
      return chain;
    } } },
  });
}
const A = Keypair.generate().publicKey, B = Keypair.generate().publicKey;
const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), user);
const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), user);
const qa = (o: Partial<QuotedLeg> = {}): QuotedLeg => ({ pool: A.toBase58(), inMint: WSOL_MINT, outMint: USDC_MINT, requested: new BN(100_000_000), consumed: new BN(100_000_000), out: new BN(12_100_000), min: new BN(12_000_000), fee: new BN(1), protocolFee: new BN(0), impactPct: "0", feeMint: WSOL_MINT, binArrays: [], ...o });
const qb = (o: Partial<QuotedLeg> = {}): QuotedLeg => ({ pool: B.toBase58(), inMint: USDC_MINT, outMint: WSOL_MINT, requested: new BN(12_000_000), consumed: new BN(12_000_000), out: new BN(104_000_000), min: new BN(103_500_000), fee: new BN(1), protocolFee: new BN(0), impactPct: "0", feeMint: USDC_MINT, binArrays: [], ...o });
const wa = (o: Partial<WalletAccounts> = {}): WalletAccounts => ({ wsolAta, usdcAta, wsolExists: false, usdcExists: true, lamports: new BN(1e9), ataRent: new BN(2_039_280), ...o });
const build = (o: { a?: QuotedLeg; b?: QuotedLeg; w?: WalletAccounts; floor?: BN; pa?: unknown; pb?: unknown } = {}) =>
  buildArbTx({ user, poolA: asAny(o.pa ?? mockPool(A, WSOL_MINT, USDC_MINT)), poolB: asAny(o.pb ?? mockPool(B, WSOL_MINT, USDC_MINT)), a: o.a ?? qa(), b: o.b ?? qb(), floor: o.floor ?? new BN(102_600_000), w: o.w ?? wa(), microLamports: new BN(1000), computeUnits: 400_000 });
const kinds = (t: Transaction) => t.instructions.map((i) => {
  const p = i.programId.toBase58();
  if (p.startsWith("ComputeBudget")) return "cu";
  if (p.startsWith("ATokenGP")) return i.data.length === 0 || i.data[0] === 0 ? "ata-create-strict" : "ata-create-idempotent";
  if (p === "11111111111111111111111111111111") return "transfer";
  if (p.startsWith("Tokenkeg")) return i.data[0] === 17 ? "sync" : i.data[0] === 9 ? "close" : `token${i.data[0]}`;
  if (p === DLMM_PROGRAM_ID) return "swap";
  return p;
});
const amounts = (i: TransactionInstruction) => [new BN(i.data.subarray(0, 8), "le").toString(), new BN(i.data.subarray(8, 16), "le").toString()];

describe("atomic round-trip composition", () => {
  it("orders wrap -> leg A -> leg B -> cleanup, strict WSOL create, no intermediate close", async () => {
    const r = await build();
    expect(kinds(r.tx)).toEqual(["cu", "cu", "ata-create-strict", "transfer", "sync", "swap", "swap", "close"]);
    const swaps = r.tx.instructions.filter((i) => i.programId.toBase58() === DLMM_PROGRAM_ID);
    expect(amounts(swaps[0]!)).toEqual(["100000000", "12000000"]);       // leg A: full input, min out
    expect(amounts(swaps[1]!)).toEqual(["12000000", "103500000"]);       // leg B: input = leg A min, min = max(b.min, floor)
    expect(swaps[0]!.keys[0]!.pubkey.equals(wsolAta) && swaps[0]!.keys[1]!.pubkey.equals(usdcAta)).toBe(true);
    expect(swaps[1]!.keys[0]!.pubkey.equals(usdcAta) && swaps[1]!.keys[1]!.pubkey.equals(wsolAta)).toBe(true);
  });
  it("pre-existing WSOL is never created or closed; missing USDC uses idempotent create, never closed", async () => {
    const r = await build({ w: wa({ wsolExists: true, usdcExists: false }) });
    expect(kinds(r.tx)).toEqual(["cu", "cu", "ata-create-idempotent", "transfer", "sync", "swap", "swap"]);
    expect(r.closesWsol).toBe(false);
  });
  it("enforces the floor on leg B and rejects a floor above leg B min", async () => {
    await expect(build({ floor: new BN(103_500_001) })).rejects.toThrow(/floor/);
  });
  it("rejects duplicate pools, quote/pool binding mismatch, unfunded leg 2 and partial fills", async () => {
    await expect(build({ pb: mockPool(A, WSOL_MINT, USDC_MINT) })).rejects.toThrow(/Duplicate/);
    await expect(build({ a: qa({ pool: B.toBase58() }) })).rejects.toThrow(/binding/);
    await expect(build({ b: qb({ requested: new BN(12_100_000), consumed: new BN(12_100_000) }) })).rejects.toThrow();
    await expect(build({ a: qa({ consumed: new BN(1) }) })).rejects.toThrow();
  });
  it("reversed canonical mint order pool still composes with the same user-side accounts", async () => {
    const r = await build({ pa: mockPool(A, USDC_MINT, WSOL_MINT) });
    expect(kinds(r.tx)).toContain("swap");
  });
  it("oversized routes are rejected as non-atomic", async () => {
    const many = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    await expect(build({ a: qa({ binArrays: many }), b: qb({ binArrays: many }) })).rejects.toThrow(/fit/);
  });
});

describe("receipt truth", () => {
  it("missing owner balance index or unsafe numbers -> UNKNOWN, not zero", () => {
    const d = realizedDeltas({ fee: 5000, err: null, preBalances: [], postBalances: [] }, "me");
    expect(d.lamports).toBeNull();
    const f = realizedDeltas({ fee: 5000, err: { InstructionError: [0, "x"] }, preBalances: [10], postBalances: [5] }, "me");
    expect(f.failed).toBe(true);
  });
});

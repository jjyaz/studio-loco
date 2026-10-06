import { describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { runTransaction, runSequence, summarize, checkSignature, confirmByPolling, isUserRejection, memoryPendingStore, TxError } from "@/lib/tx";
import { parseMintAccount, spendable, SOL_RESERVE_LAMPORTS, TOKEN_2022, TOKEN_PROGRAM, WSOL_MINT } from "@/lib/chain";
import { decodeShare, encodeShare, exportRoutes, importRoutes, isPublicKey, loadStoredRoutes, MAX_UI_BINS, type SavedRoute } from "@/lib/strategy";
import { planKey } from "@/lib/plan";
import { validateCall } from "@/routes/api/public/rpc.$cluster";
import { redactUrls } from "@/lib/format";
import { skyOf } from "@/routes/app.signals";
import { splitAmount } from "@/routes/app.pool.$address";

/* ---------------- Token programs ---------------- */
describe("token programs and mint parsing", () => {
  it("uses the official program IDs", () => {
    expect(TOKEN_2022).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(TOKEN_2022).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(TOKEN_PROGRAM).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
  const mint = (owner: PublicKey, extensions?: { extension: string }[]) => ({ owner, data: { parsed: { type: "mint", info: { decimals: 6, freezeAuthority: null, mintAuthority: null, supply: "1", extensions } } } });
  it("parses classic and Token-2022 mints", () => {
    expect(parseMintAccount("A", mint(TOKEN_PROGRAM_ID)).program).toBe("token");
    const t22 = parseMintAccount("B", mint(TOKEN_2022_PROGRAM_ID, [{ extension: "transferFeeConfig" }, { extension: "metadataPointer" }]));
    expect(t22.program).toBe("token-2022");
    expect(t22.extensions).toEqual(["transferFeeConfig", "metadataPointer"]);
    expect(t22.blockedExtensions).toEqual([]);
  });
  it("blocks hazardous extensions and rejects the old wrong ID", () => {
    expect(parseMintAccount("C", mint(TOKEN_2022_PROGRAM_ID, [{ extension: "permanentDelegate" }])).blockedExtensions).toEqual(["permanentDelegate"]);
    const wrong = { toBase58: () => "TokenzQdBNbLqP5VEhdkAS6EHFLC1PtJNrJm5gzH8Vf4" };
    expect(() => parseMintAccount("D", mint(wrong as unknown as PublicKey))).toThrow(/not an SPL token mint/);
    expect(() => parseMintAccount("E", null)).toThrow(/No account/);
  });
  it("keeps a native SOL reserve on Max", () => {
    expect(spendable(WSOL_MINT, new BN(1_000_000_000)).toString()).toBe(new BN(1_000_000_000).sub(SOL_RESERVE_LAMPORTS).toString());
    expect(spendable(WSOL_MINT, new BN(10)).toString()).toBe("0");
    expect(spendable("Other", new BN(10)).toString()).toBe("10");
  });
});

/* ---------------- Transaction runner ---------------- */
const payer = Keypair.generate();
function realTx(eph?: Keypair) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  if (eph) tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: eph.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }));
  return tx;
}
function conn(o: { simErr?: unknown; status?: unknown; statusThrows?: boolean; height?: number; sendThrows?: Error } = {}) {
  const sims: VersionedTransaction[] = [];
  return {
    sims,
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: vi.fn(async (vtx: VersionedTransaction, cfg: unknown) => { sims.push(vtx); expect(cfg).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false }); return { value: { err: o.simErr ?? null, logs: ["log"] } }; }),
    sendRawTransaction: vi.fn(async () => { if (o.sendThrows) throw o.sendThrows; return "sig"; }),
    getSignatureStatuses: vi.fn(async () => { if (o.statusThrows) throw new Error("fetch failed https://rpc.example.com/?api-key=SECRET"); return { value: [o.status === undefined ? { slot: 5, confirmationStatus: "confirmed", err: null } : o.status] }; }),
    getBlockHeight: vi.fn().mockResolvedValue(o.height ?? 50),
  };
}
const signer = () => ({
  publicKey: payer.publicKey,
  sendTransaction: vi.fn(),
  signTransaction: vi.fn(async (t: Transaction) => { t.partialSign(payer); return t; }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (x: unknown) => x as any;
const ctx = (store = memoryPendingStore()) => ({ cluster: "devnet", rpc: "relay" as const, store });

describe("transaction runner", () => {
  it("simulates the exact signed message and confirms, with an ephemeral signer", async () => {
    const c = conn();
    const w = signer();
    const eph = Keypair.generate();
    const tx = realTx(eph);
    const phases: string[] = [];
    const store = memoryPendingStore();
    const r = await runTransaction({ connection: asAny(c), wallet: asAny(w), tx, signers: [eph], ctx: ctx(store), onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["preparing", "simulating", "awaiting-signature", "sending", "confirming", "confirmed"]);
    // the simulated message bytes equal what was signed and broadcast
    const simulated = Buffer.from(c.sims[0]!.message.serialize());
    expect(simulated.equals(tx.serializeMessage())).toBe(true);
    expect(tx.signatures.every((s) => s.signature !== null)).toBe(true);
    expect(r.signature.length).toBeGreaterThan(40);
    expect(store.list()).toHaveLength(0);
  });
  it("never asks the wallet when simulation fails", async () => {
    const w = signer();
    await expect(runTransaction({ connection: asAny(conn({ simErr: { InstructionError: [0, "Custom"] } })), wallet: asAny(w), tx: realTx() })).rejects.toMatchObject({ phase: "simulating" });
    expect(w.signTransaction).not.toHaveBeenCalled();
  });
  it("refuses to send if the wallet changed the message", async () => {
    const c = conn();
    const w = { ...signer(), signTransaction: vi.fn(async (t: Transaction) => { t.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 9 })); t.partialSign(payer); return t; }) };
    await expect(runTransaction({ connection: asAny(c), wallet: asAny(w), tx: realTx() })).rejects.toThrow(/changed the transaction/);
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("reports definitive onchain failure", async () => {
    const e = await runTransaction({ connection: asAny(conn({ status: { slot: 1, confirmationStatus: "confirmed", err: { InstructionError: [0, "X"] } } })), wallet: asAny(signer()), tx: realTx() }).catch((x) => x);
    expect(e).toBeInstanceOf(TxError);
    expect(e.phase).toBe("failed");
  });
  it("expired only when history search succeeded and height passed", async () => {
    const store = memoryPendingStore();
    const e = await runTransaction({ connection: asAny(conn({ status: null, height: 101 })), wallet: asAny(signer()), tx: realTx(), ctx: ctx(store), pollMs: 1 }).catch((x) => x);
    expect(e.phase).toBe("expired");
    expect(store.list()).toHaveLength(0);
  });
  it("RPC outage gives bounded 'unknown', keeps public pending metadata and redacts URLs", async () => {
    const store = memoryPendingStore();
    const e = await runTransaction({ connection: asAny(conn({ statusThrows: true })), wallet: asAny(signer()), tx: realTx(), ctx: ctx(store), pollMs: 1, maxWaitMs: 20 }).catch((x) => x);
    expect(e.phase).toBe("unknown");
    expect(e.message).not.toContain("SECRET");
    const p = store.list()[0]!;
    expect(p).toMatchObject({ cluster: "devnet", rpc: "relay", wallet: payer.publicKey.toBase58(), lastValidBlockHeight: 100 });
    expect(JSON.stringify(p)).not.toMatch(/secret|privateKey/i);
  });
  it("a transport error on broadcast does not claim failure; it reconciles", async () => {
    const e = await runTransaction({ connection: asAny(conn({ sendThrows: new Error("network down"), status: null, height: 50 })), wallet: asAny(signer()), tx: realTx(), pollMs: 1, maxWaitMs: 10 }).catch((x) => x);
    expect(e.phase).toBe("unknown");
  });
  it("preflight rejection is definitive", async () => {
    const e = await runTransaction({ connection: asAny(conn({ sendThrows: new Error("Transaction simulation failed: Blockhash not found") })), wallet: asAny(signer()), tx: realTx() }).catch((x) => x);
    expect(e.phase).toBe("failed");
  });
  it("classifies rejection narrowly", () => {
    expect(isUserRejection({ code: 4001, message: "x" })).toBe(true);
    expect(isUserRejection(new Error("User rejected the request."))).toBe(true);
    const wrapped = Object.assign(new Error("Unexpected error"), { name: "WalletSignTransactionError" });
    expect(isUserRejection(wrapped)).toBe(false);
  });
  it("sequence stops on unknown settlement; empty sequence is not success", async () => {
    let n = 0;
    const c = { ...conn(), getSignatureStatuses: vi.fn(async () => { n++; if (n > 1) throw new Error("down"); return { value: [{ slot: 1, confirmationStatus: "confirmed", err: null }] }; }) };
    const steps = await runSequence({ connection: asAny(c), wallet: asAny(signer()), steps: [{ label: "a", tx: realTx() }, { label: "b", tx: realTx() }, { label: "c", tx: realTx() }], onUpdate: () => {}, pollMs: 1, maxWaitMs: 10 });
    expect(steps.map((s) => s.phase)).toEqual(["confirmed", "unknown", "skipped"]);
    expect(summarize(steps).kind).toBe("unknown");
    expect(summarize([]).kind).toBe("none");
  });
  it("rejection in a sequence skips later steps", async () => {
    let k = 0;
    const w = { ...signer(), signTransaction: vi.fn(async (t: Transaction) => { k++; if (k === 2) throw Object.assign(new Error("User rejected the request."), { code: 4001 }); t.partialSign(payer); return t; }) };
    const steps = await runSequence({ connection: asAny(conn()), wallet: asAny(w), steps: [{ label: "a", tx: realTx() }, { label: "b", tx: realTx() }, { label: "c", tx: realTx() }], onUpdate: () => {} });
    expect(steps.map((s) => s.phase)).toEqual(["confirmed", "rejected", "skipped"]);
  });
  it("checkSignature reconciles pending vs confirmed", async () => {
    expect((await checkSignature(asAny(conn({ status: { slot: 1, confirmationStatus: "processed", err: null } })), "s", 100)).kind).toBe("pending");
    expect((await confirmByPolling(asAny(conn({ status: null, height: 10 })), "s", 100, { pollMs: 1, maxWaitMs: 5 })).kind).toBe("unknown");
  });
});

/* ---------------- Saved routes ---------------- */
const POOL = "DQ9weJhfiU4iL5LUoeshDrm5KxDHCMiSbnnKJz7buMcf";
const route = (o: Partial<SavedRoute> = {}): SavedRoute => ({ id: "a", name: "Test", cluster: "mainnet-beta", pool: POOL, strategy: "Curve", below: 5, above: 5, exec: { x: "1.5", y: "0" }, illustrative: { budget: 10, xShare: 0.5 }, createdAt: 1, ...o });

describe("saved routes v2", () => {
  it("validates real public keys", () => {
    expect(isPublicKey(POOL)).toBe(true);
    expect(isPublicKey("1".repeat(44))).toBe(false); // base58-looking but not 32 bytes
  });
  it("round trips and keeps cluster identity", () => {
    const r = importRoutes(exportRoutes([route({ cluster: "devnet" })]));
    expect(r.ok && r.routes[0]!.cluster).toBe("devnet");
    expect(decodeShare(encodeShare(route()))).toEqual(route());
  });
  it("refuses combined width over the cap everywhere", () => {
    const wide = route({ below: 40, above: 40 });
    expect(importRoutes(exportRoutes([wide])).ok).toBe(false);
    expect(decodeShare(encodeShare(wide))).toBeNull();
    expect(loadStoredRoutes([wide, route()])).toHaveLength(1);
    expect(route({ below: 34, above: 34 }).below + 34 + 1).toBeLessThanOrEqual(MAX_UI_BINS);
  });
  it("rejects non-finite / float-like amounts", () => {
    expect(importRoutes(exportRoutes([route({ illustrative: { budget: Infinity, xShare: 0.5 } })])).ok).toBe(false);
    expect(importRoutes(exportRoutes([route({ exec: { x: "1e5", y: "" } })])).ok).toBe(false);
  });
  it("migrates v1 without inventing a cluster", () => {
    const v1 = { kind: "studio-loco/routes", version: 1, routes: [{ id: "a", name: "Old", pool: POOL, strategy: "Spot", below: 3, above: 3, budget: 5, xShare: 0.5, createdAt: 1 }] };
    const r = importRoutes(JSON.stringify(v1));
    expect(r.ok && r.migrated).toBe(1);
    expect(r.ok && r.routes[0]!.cluster).toBeNull();
    expect(r.ok && r.routes[0]!.exec).toEqual({ x: "", y: "" });
    expect(importRoutes("{").ok).toBe(false);
  });
});

/* ---------------- Plans, relay, data truth ---------------- */
describe("plan identity", () => {
  it("changes with any bound input", () => {
    const base = { wallet: "W", cluster: "mainnet-beta", rpc: "r", price: "1", preset: "p" };
    expect(planKey(base)).toBe(planKey({ ...base }));
    for (const k of Object.keys(base)) expect(planKey({ ...base, [k]: "changed" })).not.toBe(planKey(base));
  });
});

describe("rpc relay validation", () => {
  const ok = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
  it("accepts well-formed allowlisted calls", () => expect(validateCall(ok)).toBeNull());
  it("rejects malformed or out-of-scope calls", () => {
    expect(validateCall({ ...ok, method: "requestAirdrop" })).toMatch(/not allowed/);
    expect(validateCall({ ...ok, jsonrpc: "1.0" })).toBeTruthy();
    expect(validateCall({ ...ok, params: { a: 1 } })).toMatch(/array/);
    expect(validateCall({ ...ok, method: "getProgramAccounts", params: [TOKEN_PROGRAM, { filters: [{}] }] })).toMatch(/DLMM/);
    expect(validateCall({ ...ok, method: "getProgramAccounts", params: ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", {}] })).toMatch(/filters/);
    expect(validateCall({ ...ok, method: "sendTransaction", params: [123] })).toMatch(/encoded/);
  });
  it("redacts URLs from messages", () => expect(redactUrls("failed https://x.io/?api-key=abc now")).toBe("failed [RPC endpoint] now"));
});

describe("data truth helpers", () => {
  it("sky labels need both readings (callers pass undefined → Unavailable)", () => {
    expect(skyOf(0, 0.25)).toBe("Calm");
    expect(skyOf(0.2, 0.25)).toBe("Storm");
  });
  it("splits order amounts exactly", () => {
    const parts = splitAmount(new BN("1000000001"), 3);
    expect(parts.reduce((a, b) => a.add(b), new BN(0)).toString()).toBe("1000000001");
    expect(splitAmount(new BN(5), 0)).toEqual([]);
  });
});

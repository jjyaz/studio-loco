import { describe, expect, it } from "vitest";
import { Keypair, Connection } from "@solana/web3.js";
import { installNodeGlobals } from "@/lib/polyfills";
import { buildMetadataBody } from "@/lib/depot.server";
import { rebuildLaunchMessage, verifyAndLinkLaunch, type LaunchDeps } from "@/lib/depot-launch.server";
import { sanitizePassport, isAddress32 } from "@/lib/depot-contracts";

installNodeGlobals();
const conn = new Connection("http://127.0.0.1:1"); // builder makes no RPC calls
const owner = Keypair.generate().publicKey.toBase58();
const config = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();
const { body, digest } = buildMetadataBody({ name: "Loco Scout", symbol: "SCOUT", description: "d", image: "https://studioloco.cfd/api/public/depot/image/" + "a".repeat(64) });
const uri = `https://studioloco.cfd/api/public/depot/metadata/${digest}`;
const base = { owner, config, mint, presetId: "standard-sol-85", presetVersion: 1, name: "Loco Scout", symbol: "SCOUT", uri, blockhash };

async function deps(over: Partial<LaunchDeps> & { bytes?: Uint8Array; payer?: string; err?: unknown; sig?: string } = {}) {
  const rebuilt = await rebuildLaunchMessage(conn, base);
  const linked: unknown[] = [];
  const signature = "5".repeat(88);
  const d: LaunchDeps = {
    connection: {
      getTransaction: async () => ({
        slot: 77,
        meta: { err: over.err ?? null },
        transaction: {
          signatures: [over.sig ?? signature],
          message: { staticAccountKeys: [{ toBase58: () => over.payer ?? owner }], recentBlockhash: blockhash, serialize: () => over.bytes ?? rebuilt.bytes },
        },
      }),
    } as never,
    userId: "u1",
    getAgent: async () => ({ id: "a1", user_id: "u1", revision: 3, wallet: owner, wallet_verified_at: "t", launch: null }),
    getMetadata: async () => ({ digest, user_id: "u1", agent_id: "a1", body }),
    readLifecycle: async () => ({ slot: 80 }),
    link: async (a) => { linked.push(a); return { status: "linked", revision: 4 }; },
    ...over,
  };
  const claim = { agentId: "a1", revision: 3, config, mint, pool: rebuilt.pool, signature, metadataDigest: digest, presetId: "standard-sol-85", presetVersion: 1 };
  return { d, claim, linked, rebuilt };
}

describe("verified launch linkage (exact message reconstruction)", () => {
  it("rebuild is deterministic and parameter-sensitive", async () => {
    const a = await rebuildLaunchMessage(conn, base);
    const b = await rebuildLaunchMessage(conn, base);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const otherName = await rebuildLaunchMessage(conn, { ...base, name: "Loco Scouts" });
    const otherPreset = await rebuildLaunchMessage(conn, { ...base, presetId: "small-sol-20" });
    expect(Buffer.from(otherName.bytes).equals(Buffer.from(a.bytes))).toBe(false);
    expect(Buffer.from(otherPreset.bytes).equals(Buffer.from(a.bytes))).toBe(false);
  }, 30_000);
  it("links only an exact matching receipt", async () => {
    const { d, claim, linked } = await deps();
    const r = await verifyAndLinkLaunch(claim, d);
    expect(r.launch.mint).toBe(mint);
    expect(r.launch.slot).toBe(77);
    expect(linked).toHaveLength(1);
  }, 30_000);
  it("refuses a different message (e.g. other preset or recipients)", async () => {
    const other = await rebuildLaunchMessage(conn, { ...base, presetId: "small-sol-20" });
    const { d, claim, linked } = await deps({ bytes: other.bytes });
    await expect(verifyAndLinkLaunch(claim, d)).rejects.toThrow(/differs/);
    expect(linked).toHaveLength(0);
  }, 30_000);
  it("refuses wrong payer, failed tx, wrong preset claim, foreign metadata, unverified wallet", async () => {
    let x = await deps({ payer: Keypair.generate().publicKey.toBase58() });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/fee payer/);
    x = await deps({ err: { InstructionError: [0, "x"] } });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/failed/);
    x = await deps();
    await expect(verifyAndLinkLaunch({ ...x.claim, presetId: "small-sol-20" }, x.d)).rejects.toThrow(/differs/);
    await expect(verifyAndLinkLaunch({ ...x.claim, pool: config }, x.d)).rejects.toThrow(/derive/);
    x = await deps({ getMetadata: async () => ({ digest, user_id: "other", agent_id: "a1", body }) });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/not published by this agent/);
    x = await deps({ getMetadata: async () => ({ digest, user_id: "u1", agent_id: "a1", body: body + " " }) });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/integrity/);
    x = await deps({ getAgent: async () => ({ id: "a1", user_id: "u1", revision: 3, wallet: owner, wallet_verified_at: null, launch: null }) });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/Prove control/);
    x = await deps({ getAgent: async () => ({ id: "a1", user_id: "u2", revision: 3, wallet: owner, wallet_verified_at: "t", launch: null }) });
    await expect(verifyAndLinkLaunch(x.claim, x.d)).rejects.toThrow(/not found/);
  }, 60_000);
});

describe("public passport launch sanitization", () => {
  it("keeps only schema-valid launch fields", () => {
    const launch = { cluster: "mainnet-beta", config, mint, pool: config, signature: "5".repeat(88), slot: 1, presetId: "standard-sol-85", presetVersion: 1, metadataDigest: digest, verifiedAt: "2026-10-20T00:00:00.000Z" };
    expect(sanitizePassport({ launch })?.launch).toEqual(launch);
    expect(sanitizePassport({ launch: { ...launch, rpc: "https://secret" } })?.launch).toBeNull();
    expect(sanitizePassport({ launch: { ...launch, cluster: "devnet" } })?.launch).toBeNull();
  });
  it("address schema decodes to 32 bytes", () => {
    expect(isAddress32(owner)).toBe(true);
    expect(isAddress32("1".repeat(44))).toBe(false);
  });
});

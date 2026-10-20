// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { depotPresetCurve, loadDepotDbc, loadDepotDamm, type PreparedDepotAction } from "@/lib/depot-chain";
import { assertDepotInstructions, preserveDepotWsol } from "@/lib/depot-proof";
import { getPreset, WSOL_MINT } from "@/lib/depot";

async function actualLaunch() {
  const d = await loadDepotDbc(), owner = Keypair.generate().publicKey, mint = Keypair.generate(), config = Keypair.generate();
  const connection = new Connection("https://invalid.example");
  // Only a public quote mint owner read is required by the SDK builder. No transaction/simulation RPC.
  connection.getAccountInfo = async () => ({ owner: TOKEN_PROGRAM_ID, executable: false, data: Buffer.alloc(82), lamports: 1, rentEpoch: 0 });
  const curve = await depotPresetCurve(getPreset("small-sol-20", 1));
  const tx = await new d.DynamicBondingCurveClient(connection, "confirmed").partner.createConfigAndPool({ config: config.publicKey, feeClaimer: owner, leftoverReceiver: owner, quoteMint: new PublicKey(WSOL_MINT), payer: owner, ...curve, preCreatePoolParam: { name: "Scout", symbol: "SCOUT", uri: "https://studioloco.cfd/m/test", poolCreator: owner, baseMint: mint.publicKey } });
  return { kind: "launch", tx, signers: [config, mint], label: "Launch", notes: [], target: { mint: mint.publicKey.toBase58(), config: config.publicKey.toBase58(), pool: d.deriveDbcPoolAddress(new PublicKey(WSOL_MINT), mint.publicKey, config.publicKey).toBase58() }, binding: { wallet: owner.toBase58(), cluster: "mainnet-beta", rpc: "public", agentId: "test", agentRevision: 1, presetId: "small-sol-20", presetVersion: 1, metadataUri: "https://studioloco.cfd/m/test", recipients: [], maxStageLamports: 100_000_000n, maxTotalLamports: 100_000_000n } } satisfies Omit<PreparedDepotAction, "review" | "instructionKey" | "observedSlot">;
}

describe("Depot installed SDK/IDL proof", () => {
  it("accepts the actual official SDK's atomic config/pool instructions", async () => {
    await expect(assertDepotInstructions(await actualLaunch())).resolves.toBeUndefined();
  });
  it("rejects an injected transfer, changed fee recipient and extra accounts", async () => {
    const a = await actualLaunch();
    a.tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(a.binding.wallet), toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    await expect(assertDepotInstructions(a)).rejects.toThrow(/unapproved program/);
    const b = await actualLaunch();
    // Actual create_config IDL: config, fee_claimer, leftover_receiver, quote_mint, payer...
    b.tx.instructions[0]!.keys[1]!.pubkey = Keypair.generate().publicKey;
    await expect(assertDepotInstructions(b)).rejects.toThrow(/fee_claimer/);
    const c = await actualLaunch();
    c.tx.instructions[0]!.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true });
    await expect(assertDepotInstructions(c)).rejects.toThrow(/remaining accounts/);
  });
  it("accepts official DBC migration and owner claim builders; refuses claim recipient tampering", async () => {
    const a: Omit<PreparedDepotAction, "review" | "instructionKey" | "observedSlot"> = await actualLaunch();
    const d = await loadDepotDbc(), connection = new Connection("https://invalid.example");
    const client = new d.DynamicBondingCurveClient(connection, "confirmed");
    const poolState = { config: new PublicKey(a.target.config), baseMint: new PublicKey(a.target.mint), creator: new PublicKey(a.binding.wallet), baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey };
    for (const service of [client.migration, client.creator]) {
      service.state.getPool = async () => ({ poolState }) as never;
      service.state.getPoolConfig = async () => ({ quoteMint: new PublicKey(WSOL_MINT), tokenType: 0, quoteTokenFlag: 0 }) as never;
    }
    const cfg = d.DAMM_V2_MIGRATION_FEE_ADDRESS[2]!;
    const migrated = await client.migration.migrateToDammV2({ payer: new PublicKey(a.binding.wallet), pool: new PublicKey(a.target.pool), dammConfig: cfg });
    const migration = { ...a, kind: "migrate" as const, tx: migrated.transaction, target: { ...a.target, dammPool: d.deriveDammV2PoolAddress(cfg, poolState.baseMint, new PublicKey(WSOL_MINT)).toBase58() }, signers: [migrated.firstPositionNftKeypair, migrated.secondPositionNftKeypair] };
    await expect(assertDepotInstructions(migration)).resolves.toBeUndefined();
    const claim = { ...a, kind: "claim-curve" as const, signers: [], tx: await client.creator.claimCreatorTradingFee({ creator: new PublicKey(a.binding.wallet), payer: new PublicKey(a.binding.wallet), pool: new PublicKey(a.target.pool), maxBaseAmount: new BN(1), maxQuoteAmount: new BN(1) }) };
    await preserveDepotWsol(claim.tx);
    await expect(assertDepotInstructions(claim)).resolves.toBeUndefined();
    const ix = claim.tx.instructions.find(i => i.programId.equals(d.DYNAMIC_BONDING_CURVE_PROGRAM_ID))!;
    ix.keys[2]!.pubkey = getAssociatedTokenAddressSync(poolState.baseMint, Keypair.generate().publicKey);
    await expect(assertDepotInstructions(claim)).rejects.toThrow(/token_a_account/);
  });
  it("accepts a real DAMM v2 claim builder with preserved WSOL and a bound NFT position", async () => {
    const a: Omit<PreparedDepotAction, "review" | "instructionKey" | "observedSlot"> = await actualLaunch();
    const sdk = await loadDepotDamm(), connection = new Connection("https://invalid.example");
    connection.getAccountInfo = async () => null;
    const owner = new PublicKey(a.binding.wallet), pool = Keypair.generate().publicKey;
    const claimPosition = { address: Keypair.generate().publicKey.toBase58(), nftAccount: Keypair.generate().publicKey.toBase58() };
    const tx = await new sdk.CpAmm(connection).claimPositionFee({ owner, receiver: owner, tempWSolAccount: owner, feePayer: owner, pool, position: new PublicKey(claimPosition.address), positionNftAccount: new PublicKey(claimPosition.nftAccount), tokenAMint: new PublicKey(a.target.mint), tokenBMint: new PublicKey(WSOL_MINT), tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID });
    const claim = { ...a, kind: "claim-damm" as const, tx, signers: [], target: { ...a.target, dammPool: pool.toBase58() }, claimPosition };
    await preserveDepotWsol(tx);
    await expect(assertDepotInstructions(claim)).resolves.toBeUndefined();
  });
});

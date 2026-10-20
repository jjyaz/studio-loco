// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { depotPresetCurve, loadDepotDbc, type PreparedDepotAction } from "@/lib/depot-chain";
import { assertDepotInstructions } from "@/lib/depot-proof";
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
});

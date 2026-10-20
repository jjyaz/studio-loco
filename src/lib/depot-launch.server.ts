/**
 * Server-side verified launch linkage. Never trusts a client assertion: the ORIGINAL confirmed
 * message is rebuilt deterministically from the pinned preset, owner recipients, target keys and
 * the agent's own immutable metadata, then compared byte-for-byte. No signing keys are involved.
 */
import type { Connection } from "@solana/web3.js";
import { getPreset, launchMath, WSOL_MINT } from "./depot";
import { LaunchSchema, PROOF_DOMAINS, type LaunchDTO } from "./depot-contracts";
import { metadataUri, sha256Hex } from "./depot.server";

export interface LaunchClaim {
  agentId: string;
  revision: number;
  config: string;
  mint: string;
  pool: string;
  signature: string;
  metadataDigest: string;
  presetId: string;
  presetVersion: number;
}
export interface LaunchAgent {
  id: string;
  user_id: string;
  revision: number;
  wallet: string | null;
  wallet_verified_at: string | null;
  launch: unknown;
}
export interface LaunchMetadataRow {
  digest: string;
  user_id: string;
  agent_id: string | null;
  body: string;
}

/** Same deterministic launch builder as the browser review (`depot-chain.prepareDepotLaunch`), with fixed keys. */
export async function rebuildLaunchMessage(
  connection: Connection,
  o: { owner: string; config: string; mint: string; presetId: string; presetVersion: number; name: string; symbol: string; uri: string; blockhash: string },
): Promise<{ bytes: Uint8Array; pool: string }> {
  const { depotPresetCurve, loadDepotDbc } = await import("./depot-chain");
  const { PublicKey, ComputeBudgetProgram } = await import("@solana/web3.js");
  const preset = getPreset(o.presetId, o.presetVersion);
  const math = launchMath(preset);
  const d = await loadDepotDbc();
  const curve = await depotPresetCurve(preset);
  if (curve.tokenSupply?.preMigrationTokenSupply.toString() !== math.rawSupply.toString()) throw new Error("SDK economics differ from the preset");
  const owner = new PublicKey(o.owner), config = new PublicKey(o.config), mint = new PublicKey(o.mint);
  const client = new d.DynamicBondingCurveClient(connection, "confirmed");
  const tx = await client.partner.createConfigAndPool({
    config, feeClaimer: owner, leftoverReceiver: owner, quoteMint: new PublicKey(WSOL_MINT), payer: owner, ...curve,
    preCreatePoolParam: { name: o.name, symbol: o.symbol, uri: o.uri, poolCreator: owner, baseMint: mint },
  });
  tx.instructions = tx.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
  tx.feePayer = owner;
  tx.recentBlockhash = o.blockhash;
  return {
    bytes: new Uint8Array(tx.compileMessage().serialize()),
    pool: d.deriveDbcPoolAddress(new PublicKey(WSOL_MINT), mint, config).toBase58(),
  };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The metadata URI is bound to the domain of its own image URL, which publication fixed. */
export function launchUriFromMetadata(row: LaunchMetadataRow): { uri: string; name: string; symbol: string } {
  if (sha256Hex(new TextEncoder().encode(row.body)) !== row.digest) throw new Error("Stored metadata failed its integrity check");
  const body = JSON.parse(row.body) as { name?: unknown; symbol?: unknown; image?: unknown };
  if (typeof body.name !== "string" || typeof body.symbol !== "string" || typeof body.image !== "string") throw new Error("Metadata body malformed");
  const host = new URL(body.image).host;
  if (!(PROOF_DOMAINS as readonly string[]).includes(host) || host.startsWith("localhost")) throw new Error("Metadata was not published on a durable public domain");
  return { uri: metadataUri(host, row.digest), name: body.name, symbol: body.symbol };
}

export interface LaunchDeps {
  connection: Connection;
  userId: string;
  getAgent(id: string): Promise<LaunchAgent | null>;
  getMetadata(digest: string): Promise<LaunchMetadataRow | null>;
  readLifecycle(target: { config: string; mint: string; pool: string }, owner: string): Promise<{ slot: number }>;
  link(args: { agent: string; revision: number; wallet: string; digest: string; launch: LaunchDTO }): Promise<{ status: string; revision: number }>;
  now?: () => Date;
}

export async function verifyAndLinkLaunch(c: LaunchClaim, deps: LaunchDeps): Promise<{ launch: LaunchDTO; status: string; revision: number }> {
  const agent = await deps.getAgent(c.agentId);
  if (!agent || agent.user_id !== deps.userId) throw new Error("Agent not found.");
  if (!agent.wallet || !agent.wallet_verified_at) throw new Error("Prove control of the agent wallet first.");
  const owner = agent.wallet;
  const meta = await deps.getMetadata(c.metadataDigest);
  if (!meta || meta.user_id !== deps.userId || meta.agent_id !== agent.id) throw new Error("Metadata is not published by this agent.");
  const { uri, name, symbol } = launchUriFromMetadata(meta);

  const receipt = await deps.connection.getTransaction(c.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!receipt?.meta) throw new Error("Confirmed receipt unavailable. Try again after confirmation.");
  if (receipt.meta.err) throw new Error("This transaction failed onchain.");
  const msg = receipt.transaction.message;
  if (msg.staticAccountKeys[0]?.toBase58() !== owner) throw new Error("Receipt fee payer is not the agent wallet.");
  if (receipt.transaction.signatures[0] !== c.signature) throw new Error("Signature does not identify this receipt.");
  const rebuilt = await rebuildLaunchMessage(deps.connection, {
    owner, config: c.config, mint: c.mint, presetId: c.presetId, presetVersion: c.presetVersion, name, symbol, uri, blockhash: msg.recentBlockhash,
  });
  if (rebuilt.pool !== c.pool) throw new Error("Pool address does not derive from this config and mint.");
  if (!sameBytes(rebuilt.bytes, new Uint8Array(msg.serialize())))
    throw new Error("Confirmed message differs from the Depot launch rebuilt from this preset, owner, metadata and keys.");
  const life = await deps.readLifecycle({ config: c.config, mint: c.mint, pool: c.pool }, owner);
  const launch = LaunchSchema.parse({
    cluster: "mainnet-beta", config: c.config, mint: c.mint, pool: c.pool, signature: c.signature,
    slot: Math.max(receipt.slot, life.slot), presetId: c.presetId, presetVersion: c.presetVersion,
    metadataDigest: c.metadataDigest, verifiedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  const r = await deps.link({ agent: agent.id, revision: c.revision, wallet: owner, digest: c.metadataDigest, launch });
  return { launch, ...r };
}

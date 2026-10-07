import { Buffer } from "buffer";
import type { Connection, Transaction } from "@solana/web3.js";
import { GENESIS, simulateExact } from "./tx";
import { knownLamports, REVIEW_TTL_MS } from "./agents";
import type { Job } from "./job-control";

// Official Solana Memo client: solana-program/memo/clients/js-legacy/src/index.ts.
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const REHEARSAL_MEMO = "Studio Loco devnet wallet rehearsal v1; no token transfer";
export interface WalletRehearsal {
  tx: Transaction;
  owner: string;
  cluster: "devnet";
  rpcId: string;
  gen: number;
  feeLamports: number;
  balanceLamports: number;
  units: number;
  builtAt: number;
}

/** Prepare and simulate only. Signing and settlement always use the shared runner. */
export async function prepareWalletRehearsal(o: {
  connection: Connection;
  owner: string;
  cluster: string;
  rpcId: string;
  job: Job;
}): Promise<WalletRehearsal> {
  if (o.cluster !== "devnet")
    throw new Error("Wallet rehearsals are devnet only. Switch network in Settings.");
  const { connection: c, job } = o;
  job.check();
  const genesis = await job.step(c.getGenesisHash(), 15_000, "Verifying devnet");
  if (genesis !== GENESIS["devnet"])
    throw new Error("RPC genesis does not match devnet. Nothing was prepared or signed.");
  const { PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  job.check();
  const owner = new PublicKey(o.owner);
  const program = await job.step(
    c.getAccountInfo(new PublicKey(MEMO_PROGRAM), "confirmed"),
    15_000,
    "Checking Memo program",
  );
  if (!program?.executable)
    throw new Error("The official Memo program is unavailable on this endpoint.");
  const recent = await job.step(
    c.getLatestBlockhash("confirmed"),
    15_000,
    "Getting rehearsal blockhash",
  );
  const tx = new Transaction({ feePayer: owner, ...recent }).add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM),
      keys: [],
      data: Buffer.from(REHEARSAL_MEMO, "utf8"),
    }),
  );
  const fee = await job.step(
    c.getFeeForMessage(tx.compileMessage(), "confirmed"),
    15_000,
    "Checking exact fee",
  );
  if (!knownLamports(fee.value))
    throw new Error("The exact network fee is unknown. Cannot open wallet approval.");
  const balance = await job.step(c.getBalance(owner, "confirmed"), 15_000, "Reading devnet SOL");
  if (!knownLamports(balance) || balance < fee.value)
    throw new Error("Devnet SOL balance is below the rehearsal fee, or unavailable.");
  const result = await job.step(
    simulateExact(c, tx.serializeMessage()),
    15_000,
    "Simulating exact memo",
  );
  if (result.value.err)
    throw new Error(`Memo simulation failed: ${JSON.stringify(result.value.err)}`);
  const units = result.value.unitsConsumed;
  if (!Number.isSafeInteger(units) || units! < 1)
    throw new Error("Simulation compute usage is unavailable.");
  job.check();
  return {
    tx,
    owner: o.owner,
    cluster: "devnet",
    rpcId: o.rpcId,
    gen: job.gen,
    feeLamports: fee.value,
    balanceLamports: balance,
    units: units!,
    builtAt: Date.now(),
  };
}

export function rehearsalStaleReason(
  review: WalletRehearsal,
  live: { owner: string; cluster: string; rpcId: string; gen: number; practice: boolean },
  now: number,
): string | null {
  if (live.practice)
    return "Practice mode disables signing. Turn it off and prepare a fresh rehearsal.";
  if (
    live.gen !== review.gen ||
    live.owner !== review.owner ||
    live.cluster !== review.cluster ||
    live.rpcId !== review.rpcId
  )
    return "Wallet, network or settings changed. Prepare a fresh rehearsal.";
  if (now < review.builtAt || now - review.builtAt > REVIEW_TTL_MS)
    return "The 20-second review expired. Prepare it again.";
  return null;
}

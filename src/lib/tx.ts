import type { Connection, Signer, Transaction, TransactionSignature, SendOptions } from "@solana/web3.js";

/**
 * Transaction runner. Every wallet action goes through here:
 *  1. fresh blockhash + lastValidBlockHeight
 *  2. RPC simulation — a failing simulation never reaches the wallet
 *  3. wallet signs + sends (non-custodial; optional ephemeral signers are in-memory only)
 *  4. confirmation against blockhash / lastValidBlockHeight
 * Success is reported ONLY after confirmation without error.
 */
export type TxPhase =
  | "idle"
  | "preparing"
  | "simulating"
  | "awaiting-signature"
  | "sending"
  | "confirming"
  | "confirmed"
  | "failed"
  | "rejected"
  | "skipped";

export interface TxStep {
  label: string;
  phase: TxPhase;
  signature?: string;
  error?: string;
  logs?: string[];
}

export interface WalletSender {
  publicKey: { toBase58(): string } | null;
  sendTransaction: (tx: Transaction, connection: Connection, options?: SendOptions & { signers?: Signer[] }) => Promise<TransactionSignature>;
}

export class TxError extends Error {
  constructor(message: string, public phase: "simulating" | "rejected" | "sending" | "confirming", public logs?: string[], public signature?: string) {
    super(message);
  }
}

function isUserRejection(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /reject|denied|cancel|declined|WalletSignTransactionError/i.test(m);
}

export async function runTransaction(opts: {
  connection: Connection;
  wallet: WalletSender;
  tx: Transaction;
  signers?: Signer[];
  onPhase?: (p: TxPhase, info?: { signature?: string }) => void;
}): Promise<{ signature: string; slot?: number }> {
  const { connection, wallet, tx, signers = [], onPhase } = opts;
  if (!wallet.publicKey) throw new TxError("Wallet not connected", "rejected");
  onPhase?.("preparing");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx.feePayer = wallet.publicKey as any;

  onPhase?.("simulating");
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    throw new TxError(`Simulation failed: ${JSON.stringify(sim.value.err)}`, "simulating", sim.value.logs ?? undefined);
  }

  onPhase?.("awaiting-signature");
  let signature: string;
  try {
    signature = await wallet.sendTransaction(tx, connection, { signers, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    if (isUserRejection(e)) throw new TxError("You declined the request in your wallet", "rejected");
    throw new TxError(e instanceof Error ? e.message : "Wallet failed to send", "sending");
  }
  onPhase?.("confirming", { signature });
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    throw new TxError(`Transaction failed onchain: ${JSON.stringify(conf.value.err)}`, "confirming", undefined, signature);
  }
  onPhase?.("confirmed", { signature });
  return { signature, slot: conf.context.slot };
}

/**
 * Sequential multi-transaction execution. Stops at the first failure and
 * reports which steps confirmed, failed, or were skipped (partial success is explicit).
 */
export async function runSequence(opts: {
  connection: Connection;
  wallet: WalletSender;
  steps: { label: string; tx: Transaction; signers?: Signer[] }[];
  onUpdate: (steps: TxStep[]) => void;
}): Promise<TxStep[]> {
  const state: TxStep[] = opts.steps.map((s) => ({ label: s.label, phase: "idle" }));
  const emit = () => opts.onUpdate(state.map((s) => ({ ...s })));
  emit();
  for (let i = 0; i < opts.steps.length; i++) {
    const cur = state[i]!;
    const step = opts.steps[i]!;
    try {
      const { signature } = await runTransaction({
        connection: opts.connection,
        wallet: opts.wallet,
        tx: step.tx,
        signers: step.signers,
        onPhase: (p, info) => {
          cur.phase = p;
          if (info?.signature) cur.signature = info.signature;
          emit();
        },
      });
      cur.signature = signature;
      cur.phase = "confirmed";
      emit();
    } catch (e) {
      const te = e instanceof TxError ? e : null;
      cur.phase = te?.phase === "rejected" ? "rejected" : "failed";
      cur.error = e instanceof Error ? e.message : String(e);
      cur.logs = te?.logs;
      if (te?.signature) cur.signature = te.signature;
      for (let j = i + 1; j < state.length; j++) state[j]!.phase = "skipped";
      emit();
      break;
    }
  }
  return state;
}

export const summarize = (steps: TxStep[]) => {
  const ok = steps.filter((s) => s.phase === "confirmed").length;
  if (ok === steps.length) return { kind: "success" as const, text: `All ${ok} transaction(s) confirmed.` };
  if (ok === 0) return { kind: "failure" as const, text: "No transactions confirmed." };
  return { kind: "partial" as const, text: `${ok} of ${steps.length} transactions confirmed. Remaining steps did not run.` };
};

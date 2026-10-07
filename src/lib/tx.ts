import type { Connection, Signer, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { redactUrls } from "./format";

/**
 * Transaction runner. Every wallet action (swap, liquidity, claim, withdraw, close,
 * pool creation, limit orders) goes through here:
 *  1. fresh blockhash + lastValidBlockHeight, fee payer fixed
 *  2. the EXACT compiled message is simulated as a VersionedTransaction
 *     (sigVerify:false, replaceRecentBlockhash:false). The legacy
 *     `simulateTransaction(Transaction)` overload swaps in its own blockhash, so it is never used.
 *  3. ephemeral signers partial-sign (memory only), wallet signs; when the wallet exposes
 *     signTransaction we verify the signed message bytes equal the simulated bytes, then broadcast.
 *  4. a public "pending" record (signature, blockhash, last-valid height, cluster, wallet) is stored
 *     before broadcast so reloads keep unresolved signatures.
 *  5. bounded confirmation. Outcomes: confirmed | failed (definitive) | expired (proven) | unknown.
 * Success is reported ONLY after confirmation without error. Nothing is ever resent automatically.
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
  | "expired"
  | "unknown"
  | "skipped";

export const TERMINAL_PHASES: TxPhase[] = ["confirmed", "failed", "rejected", "expired", "unknown", "skipped"];

export interface PendingTx {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  cluster: string;
  /** "relay" or "custom" — never the URL (custom RPC URLs can embed API keys) */
  rpc: "relay" | "custom" | "public";
  wallet: string;
  label: string;
  createdAt: number;
}

export interface TxStep {
  label: string;
  phase: TxPhase;
  signature?: string;
  error?: string;
  logs?: string[];
  pending?: PendingTx;
  /** Network captured when the sequence started — explorer links use this, not current settings. */
  cluster?: string;
}

export interface WalletSender {
  publicKey: { toBase58(): string } | null;
  sendTransaction?: unknown;
  /** Required for money-moving flows: signed bytes are compared with the simulated bytes and broadcast by us. */
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
}

export interface TxContext {
  cluster: string;
  rpc: PendingTx["rpc"];
  store?: PendingStore;
  /** Re-checked before every signature: returns a reason when wallet/cluster changed mid-flow. */
  identityGuard?: () => string | null;
  /** Optional caller-specific check (quote age, config generation…). Same call sites as identityGuard. */
  semanticGuard?: () => string | null;
  /** When set, the fresh message's getFeeForMessage must be known and <= this many lamports, or nothing is signed. */
  maxFeeLamports?: number;
}

export const UNSUPPORTED_WALLET =
  "This wallet can't return a signed transaction for verification, so Studio Loco won't use it to move funds. Use a wallet that supports transaction signing, such as Phantom or Solflare.";

/** Known genesis hashes. A settings label does not prove an endpoint's network; this does. */
export const GENESIS: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/** Hard time limit for a single RPC wait. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

const genesisCache = new WeakMap<object, string>();
/** Throws unless the connection's genesis hash matches the expected cluster. */
export async function assertCluster(connection: Connection, cluster: string, timeoutMs = 10_000): Promise<void> {
  const want = GENESIS[cluster];
  if (!want) throw new TxError(`Unknown network "${cluster}"; refusing to continue.`, "sending");
  let got = genesisCache.get(connection as object);
  if (!got) {
    try { got = await withTimeout(connection.getGenesisHash(), timeoutMs, "Network check"); }
    catch (e) { throw new TxError(`Could not verify which network the RPC is on: ${e instanceof Error ? e.message : String(e)}`, "sending"); }
    genesisCache.set(connection as object, got);
  }
  if (got !== want) throw new TxError(`The RPC endpoint is not on ${cluster} (genesis hash mismatch). Nothing was signed — check the RPC in Settings.`, "sending");
}

export class TxError extends Error {
  constructor(
    message: string,
    public phase: "simulating" | "rejected" | "sending" | "failed" | "expired" | "unknown",
    public logs?: string[],
    public signature?: string,
    public pending?: PendingTx,
  ) {
    super(redactUrls(message));
  }
}

/** Only explicit user rejections count — WalletSignTransactionError also wraps real wallet failures. */
export function isUserRejection(e: unknown): boolean {
  const err = e as { code?: unknown; error?: { code?: unknown; message?: unknown }; message?: unknown };
  if (err?.code === 4001 || err?.error?.code === 4001) return true;
  const m = [err?.message, err?.error?.message].filter((x) => typeof x === "string").join(" ");
  return /user rejected|rejected the request|request rejected|user denied|denied by user|user declined|declined by user|user cancel+ed|approval denied/i.test(m);
}

/* ---------------- pending store (public metadata only) ---------------- */

export interface PendingStore {
  list(): PendingTx[];
  put(p: PendingTx): void;
  remove(signature: string): void;
}

const PENDING_KEY = "studio-loco:pending-tx:v1";

export const browserPendingStore: PendingStore = {
  list() {
    if (typeof window === "undefined") return [];
    try {
      const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? (v as PendingTx[]).filter((p) => typeof p?.signature === "string").slice(0, 50) : [];
    } catch {
      return [];
    }
  },
  put(p) {
    if (typeof window === "undefined") return;
    const all = browserPendingStore.list().filter((x) => x.signature !== p.signature);
    localStorage.setItem(PENDING_KEY, JSON.stringify([p, ...all].slice(0, 50)));
    window.dispatchEvent(new Event("studio-loco:pending"));
  },
  remove(sig) {
    if (typeof window === "undefined") return;
    localStorage.setItem(PENDING_KEY, JSON.stringify(browserPendingStore.list().filter((x) => x.signature !== sig)));
    window.dispatchEvent(new Event("studio-loco:pending"));
  },
};

export function memoryPendingStore(): PendingStore {
  let items: PendingTx[] = [];
  return {
    list: () => items,
    put: (p) => { items = [p, ...items.filter((x) => x.signature !== p.signature)]; },
    remove: (s) => { items = items.filter((x) => x.signature !== s); },
  };
}

/* ---------------- simulation of the exact message ---------------- */

export async function simulateExact(connection: Connection, messageBytes: Uint8Array) {
  const { VersionedMessage, VersionedTransaction } = await import("@solana/web3.js");
  const vtx = new VersionedTransaction(VersionedMessage.deserialize(messageBytes));
  return connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ---------------- run one transaction ---------------- */

export async function runTransaction(opts: {
  connection: Connection;
  wallet: WalletSender;
  tx: Transaction;
  signers?: Signer[];
  ctx?: TxContext;
  label?: string;
  onPhase?: (p: TxPhase, info?: { signature?: string; pending?: PendingTx }) => void;
  pollMs?: number;
  maxWaitMs?: number;
}): Promise<{ signature: string; slot?: number }> {
  const { connection, wallet, tx, signers = [], onPhase, pollMs = 2000, maxWaitMs = 90_000 } = opts;
  const ctx: TxContext = opts.ctx ?? { cluster: "unknown", rpc: "public" };
  if (!wallet.publicKey) throw new TxError("Wallet not connected", "rejected");
  if (!wallet.signTransaction) throw new TxError(UNSUPPORTED_WALLET, "sending");
  const signFn = wallet.signTransaction;
  const guard = () => {
    const r = ctx.identityGuard?.() ?? ctx.semanticGuard?.();
    if (r) throw new TxError(r, "sending");
    const unresolved = ctx.store?.list().find((p) => p.wallet === wallet.publicKey!.toBase58() && p.cluster === ctx.cluster);
    if (unresolved) throw new TxError("This wallet has an unresolved transaction on this network. Use Check status before preparing another action; nothing was signed or sent.", "sending");
  };
  onPhase?.("preparing");
  guard();
  if (ctx.cluster !== "unknown") await assertCluster(connection, ctx.cluster);
  const { blockhash, lastValidBlockHeight } = await withTimeout(connection.getLatestBlockhash("confirmed"), 15_000, "Fetching a recent blockhash");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx.feePayer = wallet.publicKey as any;
  const messageBytes = new Uint8Array(tx.serializeMessage());
  if (ctx.maxFeeLamports !== undefined) {
    let fee: number | null;
    try { fee = (await withTimeout(connection.getFeeForMessage(tx.compileMessage(), "confirmed"), 10_000, "Fee lookup")).value; }
    catch (e) { throw new TxError(`Network fee unknown (${e instanceof Error ? e.message : String(e)}); nothing was signed.`, "sending"); }
    if (fee === null || !Number.isSafeInteger(fee) || fee < 0) throw new TxError("Network fee unknown for the fresh message; nothing was signed.", "sending");
    if (fee > ctx.maxFeeLamports) throw new TxError(`Network fee rose to ${fee} lamports, above the reviewed ${ctx.maxFeeLamports}; nothing was signed.`, "sending");
  }
  guard();

  onPhase?.("simulating");
  const sim = await withTimeout(simulateExact(connection, messageBytes), 20_000, "Simulation");
  if (sim.value.err) {
    throw new TxError(`Simulation failed: ${JSON.stringify(sim.value.err)}`, "simulating", sim.value.logs ?? undefined);
  }

  onPhase?.("awaiting-signature");
  if (signers.length) tx.partialSign(...signers);
  let signature: string;
  let pending: PendingTx;
  const mkPending = (sig: string): PendingTx => ({
    signature: sig, blockhash, lastValidBlockHeight, cluster: ctx.cluster, rpc: ctx.rpc,
    wallet: wallet.publicKey!.toBase58(), label: opts.label ?? "Transaction", createdAt: Date.now(),
  });

  let signed: Transaction;
  try {
    guard();
    signed = await signFn(tx);
  } catch (e) {
    if (isUserRejection(e)) throw new TxError("You declined the request in your wallet", "rejected");
    throw new TxError(`Wallet could not sign: ${e instanceof Error ? e.message : String(e)}`, "sending");
  }
  // Wallet/network may have changed while the approval dialog was open: stop before anything is
  // persisted or broadcast. The signed bytes are discarded.
  guard();
  if (!sameBytes(new Uint8Array(signed.serializeMessage()), messageBytes)) {
    throw new TxError("Your wallet changed the transaction after simulation, so it was not sent. Review again.", "sending");
  }
  const sigBytes = signed.signature;
  if (!sigBytes) throw new TxError("Wallet returned an unsigned transaction", "sending");
  signature = bs58.encode(sigBytes);
  pending = mkPending(signature);
  ctx.store?.put(pending);
  onPhase?.("sending", { signature, pending });
  try {
    await withTimeout(connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }), 20_000, "Broadcast");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const logs = (e as { logs?: string[] })?.logs;
    // A preflight rejection is definitive (the RPC refused it). Transport errors are not.
    if (!/already been processed/i.test(msg) && /Transaction simulation failed|preflight|Blockhash not found/i.test(msg)) {
      ctx.store?.remove(signature);
      throw new TxError(`RPC rejected the transaction: ${msg}`, "failed", logs, signature);
    }
    // Unknown: it may or may not have reached the cluster. Fall through to status checks.
  }

  onPhase?.("confirming", { signature, pending });
  const conf = await confirmByPolling(connection, signature, lastValidBlockHeight, { pollMs, maxWaitMs });
  if (conf.kind === "unknown") {
    throw new TxError(`Settlement unknown: ${conf.reason}. Do not resend — use “Check status”.`, "unknown", undefined, signature, pending);
  }
  ctx.store?.remove(signature);
  if (conf.kind === "expired") {
    throw new TxError("Blockhash expired and the signature is not in cluster history: the transaction did not land. It is safe to rebuild and retry.", "expired", undefined, signature);
  }
  if (conf.err) {
    throw new TxError(`Transaction failed onchain: ${JSON.stringify(conf.err)}`, "failed", undefined, signature);
  }
  onPhase?.("confirmed", { signature });
  return { signature, slot: conf.slot };
}

/* ---------------- confirmation ---------------- */

export type Settlement =
  | { kind: "confirmed"; err: unknown; slot?: number }
  | { kind: "expired" }
  | { kind: "unknown"; reason: string };

/** One reconciliation pass. "expired" requires a successful history search AND height past expiry. */
export async function checkSignature(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<Settlement | { kind: "pending" }> {
  let st;
  try {
    st = await withTimeout(connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 10_000, "Status lookup");
  } catch (e) {
    return { kind: "unknown", reason: `status lookup failed (${e instanceof Error ? e.message.slice(0, 80) : "RPC error"})` };
  }
  const v = st?.value?.[0];
  if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return { kind: "confirmed", err: v.err, slot: v.slot };
  if (v?.err) return { kind: "confirmed", err: v.err, slot: v.slot };
  if (v) return { kind: "pending" }; // processed only
  let height: number;
  try {
    height = await withTimeout(connection.getBlockHeight("confirmed"), 10_000, "Block height lookup");
  } catch {
    return { kind: "unknown", reason: "block height lookup failed" };
  }
  if (height > lastValidBlockHeight) {
    // Re-check history once more after observing expiry to avoid a race with late confirmation.
    try {
      const again = await withTimeout(connection.getSignatureStatuses([signature], { searchTransactionHistory: true }), 10_000, "Status lookup");
      const a = again?.value?.[0];
      if (a && (a.confirmationStatus === "confirmed" || a.confirmationStatus === "finalized" || a.err)) return { kind: "confirmed", err: a.err, slot: a.slot };
      if (a) return { kind: "pending" };
      return { kind: "expired" };
    } catch {
      return { kind: "unknown", reason: "final history lookup failed after expiry" };
    }
  }
  return { kind: "pending" };
}

/** Bounded polling. Never loops forever; RPC outages become "unknown", not "expired". */
export async function confirmByPolling(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  o: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<Settlement> {
  const pollMs = o.pollMs ?? 2000;
  const deadline = Date.now() + (o.maxWaitMs ?? 90_000);
  let lastReason = "confirmation window elapsed";
  for (;;) {
    const r = await checkSignature(connection, signature, lastValidBlockHeight);
    if (r.kind === "confirmed" || r.kind === "expired") return r;
    if (r.kind === "unknown") lastReason = r.reason;
    if (Date.now() >= deadline) return { kind: "unknown", reason: r.kind === "pending" ? "not confirmed within the confirmation window" : lastReason };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/* ---------------- sequences ---------------- */

/**
 * Sequential multi-transaction execution. Stops at the first non-confirmed step
 * (including unknown settlement) and reports confirmed / failed / unknown / skipped explicitly.
 */
export async function runSequence(opts: {
  connection: Connection;
  wallet: WalletSender;
  steps: { label: string; tx: Transaction; signers?: Signer[] }[];
  onUpdate: (steps: TxStep[]) => void;
  ctx?: TxContext;
  pollMs?: number;
  maxWaitMs?: number;
}): Promise<TxStep[]> {
  const state: TxStep[] = opts.steps.map((s) => ({ label: s.label, phase: "idle", cluster: opts.ctx?.cluster }));
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
        ctx: opts.ctx,
        label: step.label,
        pollMs: opts.pollMs,
        maxWaitMs: opts.maxWaitMs,
        onPhase: (p, info) => {
          cur.phase = p;
          if (info?.signature) cur.signature = info.signature;
          if (info?.pending) cur.pending = info.pending;
          emit();
        },
      });
      cur.signature = signature;
      cur.phase = "confirmed";
      cur.pending = undefined;
      emit();
    } catch (e) {
      const te = e instanceof TxError ? e : null;
      cur.phase = te?.phase === "rejected" ? "rejected" : te?.phase === "unknown" ? "unknown" : te?.phase === "expired" ? "expired" : "failed";
      cur.error = e instanceof Error ? e.message : String(e);
      cur.logs = te?.logs;
      if (te?.signature) cur.signature = te.signature;
      cur.pending = te?.phase === "unknown" ? te.pending : undefined;
      for (let j = i + 1; j < state.length; j++) state[j]!.phase = "skipped";
      emit();
      break;
    }
  }
  return state;
}

export type SummaryKind = "success" | "partial" | "failure" | "unknown" | "none";

export const summarize = (steps: TxStep[]): { kind: SummaryKind; text: string } => {
  if (steps.length === 0) return { kind: "none", text: "Nothing was sent." };
  const ok = steps.filter((s) => s.phase === "confirmed").length;
  const unknown = steps.some((s) => s.phase === "unknown");
  if (ok === steps.length) return { kind: "success", text: `All ${ok} transaction(s) confirmed.` };
  if (unknown) return { kind: "unknown", text: `${ok} of ${steps.length} confirmed; one is unresolved. Check its status before doing anything else — later steps were stopped.` };
  if (ok === 0) return { kind: "failure", text: "No transactions confirmed." };
  return { kind: "partial", text: `${ok} of ${steps.length} transactions confirmed. Remaining steps did not run.` };
};

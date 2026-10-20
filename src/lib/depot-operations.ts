/** Fail-closed device ledger for Depot actions. Public evidence only, never keypairs/RPC URLs. */
import { z } from "zod";
import type { Connection, Transaction } from "@solana/web3.js";
import type { PendingTx, TxContext, TxStep } from "./tx";
import { assertCluster, checkSignature } from "./tx";
import { checkDepotFreshCosts, depotActionGuard, type PreparedDepotAction } from "./depot-chain";
import type { ReviewBinding } from "./depot";

const Target = z.object({ config: z.string(), mint: z.string(), pool: z.string(), dammPool: z.string().optional() }).strict();
const Pending = z.object({ signature: z.string(), blockhash: z.string(), lastValidBlockHeight: z.number().int().nonnegative(), cluster: z.string(), rpc: z.enum(["relay", "custom", "public"]), wallet: z.string(), label: z.string(), createdAt: z.number() }).strict();
export const DepotOperationSchema = z.object({
  v: z.literal(1), id: z.string(), agentId: z.string(), agentRevision: z.number().int(),
  wallet: z.string(), cluster: z.string(), kind: z.enum(["launch", "migrate", "claim-curve", "claim-damm", "reserve"]),
  target: Target, label: z.string(), createdAt: z.number(), updatedAt: z.number(),
  state: z.enum(["reserved", "pending", "unknown", "confirmed", "verified", "failed", "expired", "cancelled"]),
  reviewKey: z.string(), instructionDigest: z.string(), signedMessageDigest: z.string().optional(),
  pending: Pending.optional(), slot: z.number().int().optional(), error: z.string().max(1000).optional(),
  verification: z.string().max(1000).optional(),
}).strict();
export type DepotOperation = z.infer<typeof DepotOperationSchema>;
const OPEN = new Set<DepotOperation["state"]>(["reserved", "pending", "unknown", "confirmed"]);
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (!database) {
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("Durable device storage is required before signing a Depot action")); return; }
      const req = indexedDB.open("studio-loco-depot", 1);
      const t = setTimeout(() => reject(new Error("Depot storage timed out")), 4000);
      req.onupgradeneeded = () => req.result.createObjectStore("operations", { keyPath: "id" });
      req.onsuccess = () => { clearTimeout(t); resolve(req.result); };
      req.onerror = req.onblocked = () => { clearTimeout(t); reject(new Error("Depot storage unavailable")); };
    });
    database = p; void p.catch(() => { if (database === p) database = undefined; });
  }
  return database;
}

/** One read/write transaction makes concurrent tab reservations serializable. */
async function mutate(f: (rows: DepotOperation[]) => DepotOperation | null): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("operations", "readwrite"), store = tx.objectStore("operations");
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* settled */ } reject(new Error("Depot evidence write timed out")); }, 4000);
    tx.oncomplete = () => { clearTimeout(timer); if (typeof window !== "undefined") window.dispatchEvent(new Event("studio-loco:depot")); resolve(); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error("Depot evidence write refused")); };
    const q = store.getAll();
    q.onsuccess = () => {
      try { const rows = q.result.map(x => DepotOperationSchema.parse(x)); const row = f(rows); if (row) store.put(DepotOperationSchema.parse(row)); }
      catch (e) { tx.abort(); clearTimeout(timer); reject(e); }
    };
  });
}

export async function listDepotOperations(agentId?: string): Promise<DepotOperation[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const q = db.transaction("operations").objectStore("operations").getAll();
    q.onsuccess = () => {
      try { resolve(q.result.map(x => DepotOperationSchema.parse(x)).filter(r => !agentId || r.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt)); }
      catch { reject(new Error("Depot evidence could not be decoded. Signing is blocked until reconciled.")); }
    };
    q.onerror = () => reject(new Error("Depot evidence unavailable"));
  });
}

const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), b => b.toString(16).padStart(2, "0")).join("");

export async function reserveDepotOperation(p: PreparedDepotAction): Promise<string> {
  const id = crypto.randomUUID(), at = Date.now(), instructionDigest = await hex(new TextEncoder().encode(p.instructionKey));
  await mutate(rows => {
    const same = rows.filter(x => x.agentId === p.binding.agentId && x.cluster === p.binding.cluster);
    if (same.some(x => OPEN.has(x.state))) throw new Error("This agent has an unresolved action. Reconcile it before preparing another.");
    if (p.kind === "launch" && same.some(x => x.kind === "launch" && x.state === "verified")) throw new Error("This agent already has a verified token launch");
    return { v: 1, id, agentId: p.binding.agentId, agentRevision: p.binding.agentRevision, wallet: p.binding.wallet, cluster: p.binding.cluster, kind: p.kind, target: p.target, label: p.label, createdAt: at, updatedAt: at, state: "reserved", reviewKey: p.review.key, instructionDigest };
  });
  return id;
}

/** No arbitrary patch/export import API can silently clear an unknown signed liability. */
async function update(id: string, f: (row: DepotOperation) => DepotOperation) {
  await mutate(rows => { const row = rows.find(r => r.id === id); if (!row) throw new Error("Depot operation is missing"); return { ...f(row), updatedAt: Date.now() }; });
}

export function depotPolicyGuard(options: { connection: Connection; prepared: PreparedDepotAction; current: () => ReviewBinding; reserved: (id: string) => void }): NonNullable<TxContext["policyGuard"]> {
  let operationId: string | undefined;
  const verify = (tx: Transaction) => { const reason = depotActionGuard(options.prepared, options.current(), tx); if (reason) throw new Error(reason); };
  return {
    async beforeSign(tx) {
      verify(tx);
      await checkDepotFreshCosts(options.connection, options.prepared, tx);
      verify(tx);
      operationId = await reserveDepotOperation(options.prepared);
      options.reserved(operationId);
    },
    async beforeBroadcast(tx, bytes, pending) {
      verify(tx);
      if (!operationId) throw new Error("Depot reservation missing");
      const digest = await hex(bytes);
      if (pending.wallet !== options.prepared.binding.wallet || pending.cluster !== options.prepared.binding.cluster) throw new Error("Pending identity changed");
      await update(operationId, row => {
        if (row.state !== "reserved") throw new Error("Depot operation cannot be signed twice");
        return { ...row, state: "pending", pending, signedMessageDigest: digest };
      });
    },
  };
}

export async function settleDepotOperation(id: string, step?: TxStep): Promise<void> {
  await update(id, row => {
    // A failed call never erases a signature durably stored before broadcast.
    const pending = row.pending ?? step?.pending;
    if (!pending) return { ...row, state: "cancelled", error: step?.error?.slice(0, 1000) };
    const state = step?.phase === "confirmed" ? "confirmed" : step?.phase === "failed" ? "failed" : step?.phase === "expired" ? "expired" : "unknown";
    return { ...row, pending, state, error: step?.error?.slice(0, 1000) };
  });
}

/** Manual read-only reconciliation. Never resends. Expiry requires tx.ts's history proof. */
export async function reconcileDepotOperation(connection: Connection, row: DepotOperation): Promise<void> {
  await assertCluster(connection, row.cluster);
  if (!row.pending) throw new Error("No broadcast signature was recorded. This unsigned reservation can be released separately.");
  const outcome = await checkSignature(connection, row.pending.signature, row.pending.lastValidBlockHeight);
  await update(row.id, current => {
    if (current.pending?.signature !== row.pending!.signature || current.signedMessageDigest !== row.signedMessageDigest) throw new Error("Operation evidence changed");
    if (current.state === "verified") return current;
    if (outcome.kind === "confirmed") return { ...current, state: outcome.err ? "failed" : "confirmed", slot: outcome.slot, error: outcome.err ? JSON.stringify(outcome.err).slice(0, 1000) : undefined };
    return { ...current, state: outcome.kind === "expired" ? "expired" : "unknown" };
  });
}

/** Only unsigned reservations may be released. Signed/unknown actions have no timeout escape. */
export async function releaseUnsignedDepotOperation(id: string): Promise<void> {
  await update(id, row => { if (row.pending || row.signedMessageDigest || row.state !== "reserved") throw new Error("Signed evidence cannot be released without receipt reconciliation"); return { ...row, state: "cancelled", verification: "Released unsigned device reservation; no broadcast signature exists." }; });
}

/** Called only after a confirmed receipt plus independent protocol-state verification. */
export async function verifyDepotOperation(connection: Connection, row: DepotOperation): Promise<void> {
  if (row.state !== "confirmed" || !row.pending || !row.signedMessageDigest) throw new Error("A confirmed receipt is required");
  await assertCluster(connection, row.cluster);
  const receipt = await connection.getTransaction(row.pending.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!receipt?.meta || receipt.meta.err || !receipt.transaction.message.staticAccountKeys[0]?.toBase58 || receipt.transaction.message.staticAccountKeys[0].toBase58() !== row.wallet) throw new Error("Successful receipt with the original wallet payer unavailable");
  const digest = await hex(receipt.transaction.message.serialize());
  if (digest !== row.signedMessageDigest) throw new Error("Confirmed message does not match the message recorded before broadcast");
  const { readDepotLifecycle } = await import("./depot-chain");
  const state = await readDepotLifecycle(connection, row.target, row.wallet, row.cluster);
  if (row.kind === "migrate" && state.status !== "graduated") throw new Error("Receipt confirmed; graduated state not yet verified");
  await update(row.id, current => { if (current.pending?.signature !== row.pending!.signature || current.signedMessageDigest !== digest || current.state !== "confirmed") throw new Error("Receipt evidence changed"); return { ...current, state: "verified", slot: receipt.slot, verification: `Exact signed-message receipt matched; owner/mint/config/PDA and ${state.status} state independently read at slot ${state.slot}.` }; });
}

export function depotOperationBlocks(row: DepotOperation) { return OPEN.has(row.state); }

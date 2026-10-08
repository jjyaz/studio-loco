/**
 * Flight Recorder device storage (IndexedDB) + optional private cloud copy.
 * Browser-only; every function is a no-op during SSR.
 */
import { RecordSchema, newId, phaseEvents, redact, statusFromSteps, stepsFromRunner, type FlightRecord } from "./recorder";
import type { PendingTx, TxStep } from "./tx";

const DB = "studio-loco-recorder";
const STORE = "records";
const MAX = 2000;
let dbp: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();
let memory: Map<string, FlightRecord> | null = null; // fallback when IndexedDB is unavailable
let version = 0;

export const recorderAvailable = () => typeof window !== "undefined";
export const usingMemoryFallback = () => memory !== null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      if (typeof indexedDB === "undefined") { rej(new Error("IndexedDB unavailable")); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: "id" }); s.createIndex("updatedAt", "updatedAt"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    dbp.catch(() => { memory = memory ?? new Map(); });
  }
  return dbp;
}

function emit() { version++; for (const f of listeners) f(); }
export function subscribeRecorder(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }
export const recorderVersion = () => version;

export async function putRecord(r: FlightRecord): Promise<void> {
  if (!recorderAvailable()) return;
  const v = RecordSchema.safeParse(r);
  if (!v.success) { console.warn("Recorder rejected an invalid record"); return; }
  try {
    const db = await open();
    await new Promise<void>((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(v.data); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } catch {
    memory = memory ?? new Map();
    memory.set(v.data.id, v.data);
  }
  emit();
}

export async function listRecords(): Promise<FlightRecord[]> {
  if (!recorderAvailable()) return [];
  try {
    const db = await open();
    const all = await new Promise<FlightRecord[]>((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).getAll(); q.onsuccess = () => res(q.result as FlightRecord[]); q.onerror = () => rej(q.error); });
    const sorted = all.sort((a, b) => b.updatedAt - a.updatedAt);
    if (sorted.length > MAX) for (const r of sorted.slice(MAX)) await deleteRecord(r.id, false);
    return sorted.slice(0, MAX);
  } catch {
    return [...(memory?.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export async function getRecord(id: string): Promise<FlightRecord | null> {
  return (await listRecords()).find((r) => r.id === id) ?? null;
}

export async function deleteRecord(id: string, notify = true): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).delete(id); t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { memory?.delete(id); }
  if (notify) emit();
}

/* ---------------- facts (proposals, reviews, handoffs) ---------------- */

export async function recordFact(o: { kind: FlightRecord["kind"]; title: string; route: string; cluster: string; wallet?: string; links?: FlightRecord["links"]; context?: FlightRecord["context"]; detail?: string; id?: string }): Promise<string> {
  const now = Date.now();
  const id = o.id ?? newId(o.kind === "proposal" ? "prop" : o.kind === "review" ? "rev" : "fact");
  const prev = o.id ? await getRecord(o.id) : null;
  const ctx: FlightRecord["context"] = {};
  for (const [k, v] of Object.entries(o.context ?? {}).slice(0, 40)) ctx[k.slice(0, 60)] = typeof v === "string" ? redact(v) : v;
  await putRecord({
    v: 1, id, kind: o.kind, provenance: "this-device", createdAt: prev?.createdAt ?? now, updatedAt: now,
    route: o.route.slice(0, 80), cluster: o.cluster, rpc: "none", wallet: o.wallet ?? "", title: redact(o.title).slice(0, 160), status: "info",
    links: { ...(prev?.links ?? {}), ...(o.links ?? {}) }, context: { ...(prev?.context ?? {}), ...ctx }, steps: [],
    timeline: [...(prev?.timeline ?? []), { at: now, event: o.kind, detail: redact(o.detail ?? o.title) }].slice(-80), postState: [],
  });
  return id;
}

/* ---------------- wallet actions (from the shared runner) ---------------- */

export interface Evidence { title?: string; links?: FlightRecord["links"]; context?: FlightRecord["context"] }

export function startWalletRecord(o: { route: string; cluster: string; rpc: "relay" | "custom"; wallet: string; labels: string[]; evidence?: Evidence }) {
  const id = newId("tx");
  const now = Date.now();
  let rec: FlightRecord = {
    v: 1, id, kind: "wallet-action", provenance: "this-device", createdAt: now, updatedAt: now,
    route: o.route.slice(0, 80), cluster: o.cluster, rpc: o.rpc, wallet: o.wallet,
    title: redact(o.evidence?.title ?? o.labels[0] ?? "Wallet action").slice(0, 160), status: "open",
    links: o.evidence?.links ?? {}, context: o.evidence?.context ?? {},
    steps: [], timeline: [{ at: now, event: "started", detail: `${o.labels.length} step(s) prepared from ${o.route}` }], postState: [],
  };
  let chain: Promise<void> = putRecord(rec);
  return {
    id,
    update(steps: TxStep[]) {
      const at = Date.now();
      const next = stepsFromRunner(steps, at, rec.steps);
      const ev = phaseEvents(rec.steps, next);
      if (!ev.length) return;
      rec = { ...rec, steps: next, status: statusFromSteps(next), updatedAt: at, timeline: [...rec.timeline, ...ev].slice(-80) };
      const snap = rec;
      chain = chain.then(() => putRecord(snap));
    },
    async addPostState(p: FlightRecord["postState"][number]) {
      rec = { ...rec, postState: [...rec.postState.filter((x) => x.signature !== p.signature), p].slice(0, 12), updatedAt: Date.now(),
        timeline: [...rec.timeline, { at: Date.now(), event: "post-state verified", detail: `${p.signature.slice(0, 12)}… via getTransaction${p.err ? ` (failed: ${p.err})` : ""}` }].slice(-80) };
      const snap = rec;
      chain = chain.then(() => putRecord(snap));
      await chain;
    },
    flush: () => chain,
  };
}

/** Reconciliation appends to the record holding the signature; never resends. */
export async function reconcileSignature(signature: string, outcome: "confirmed" | "failed" | "expired" | "pending" | "unknown", detail: string, fallback?: PendingTx) {
  const all = await listRecords();
  const now = Date.now();
  let rec = all.find((r) => r.steps.some((s) => s.signature === signature));
  if (!rec && fallback) {
    rec = {
      v: 1, id: newId("tx"), kind: "wallet-action", provenance: "this-device", createdAt: fallback.createdAt, updatedAt: now, route: "(recovered)",
      cluster: fallback.cluster, rpc: fallback.rpc, wallet: fallback.wallet, title: redact(fallback.label), status: "unknown", links: {}, context: { recoveredFrom: "unresolved-signature store" },
      steps: [{ label: redact(fallback.label), phase: "unknown", signature, at: fallback.createdAt }], timeline: [{ at: now, event: "recovered", detail: "Rebuilt from the unresolved-signature list after the original page was lost." }], postState: [],
    };
  }
  if (!rec) return;
  const steps = rec.steps.map((s) => s.signature === signature && (outcome === "confirmed" || outcome === "failed" || outcome === "expired") ? { ...s, phase: outcome, at: now } : s);
  await putRecord({ ...rec, steps, status: statusFromSteps(steps), updatedAt: now, timeline: [...rec.timeline, { at: now, event: `reconcile: ${outcome}`, detail: redact(detail) }].slice(-80) });
}

/** Ensure every unresolved signature in the pending store has a recorder entry. */
export async function adoptPending(pending: PendingTx[]) {
  if (!pending.length) return;
  const all = await listRecords();
  for (const p of pending) if (!all.some((r) => r.steps.some((s) => s.signature === p.signature))) await reconcileSignature(p.signature, "unknown", "Unresolved at load", p);
}

/* ---------------- cloud copy (optional, signed-in, RLS-private) ---------------- */

export async function syncToCloud(records: FlightRecord[]): Promise<{ pushed: number; pulled: number; error?: string }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return { pushed: 0, pulled: 0, error: "Sign in to sync" };
  const local = records.filter((r) => r.provenance === "this-device");
  for (let i = 0; i < local.length; i += 100) {
    const { error } = await supabase.from("recorder_records").upsert(local.slice(i, i + 100).map((r) => ({ user_id: u.user!.id, id: r.id, record: r as never, updated_at: new Date(r.updatedAt).toISOString() })));
    if (error) return { pushed: i, pulled: 0, error: error.message };
  }
  const { data, error } = await supabase.from("recorder_records").select("id,record").order("updated_at", { ascending: false }).limit(1000);
  if (error) return { pushed: local.length, pulled: 0, error: error.message };
  const have = new Map(records.map((r) => [r.id, r]));
  let pulled = 0;
  for (const row of data ?? []) {
    const p = RecordSchema.safeParse(row.record);
    if (!p.success) continue;
    const cur = have.get(p.data.id);
    if (!cur || cur.updatedAt < p.data.updatedAt) { await putRecord({ ...p.data, provenance: cur?.provenance === "this-device" ? "this-device" : "cloud" }); pulled++; }
  }
  return { pushed: local.length, pulled };
}

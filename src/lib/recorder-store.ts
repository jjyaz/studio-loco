/**
 * Flight Recorder device storage (IndexedDB) + optional private cloud copy.
 * Browser-only; every function is a no-op during SSR.
 */
import {
  MAX_RECORDED_STEPS,
  MAX_TIMELINE_EVENTS,
  RecordSchema,
  newId,
  phaseEvents,
  redact,
  sanitizeRecord,
  statusFromSteps,
  stepsFromRunner,
  type FlightRecord,
} from "./recorder";
import type { PendingTx, TxStep } from "./tx";

const DB = "studio-loco-recorder";
const STORE = "records";
const MAX = 2000;
let dbp: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();
let memory: Map<string, FlightRecord> | null = null; // fallback when IndexedDB is unavailable
let version = 0;
const factWrites = new Map<string, Promise<string>>();

export const recorderAvailable = () => typeof window !== "undefined";
export const usingMemoryFallback = () => memory !== null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      if (typeof indexedDB === "undefined") {
        rej(new Error("IndexedDB unavailable"));
        return;
      }
      const r = indexedDB.open(DB, 1);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        rej(new Error("Device storage did not open in time"));
      }, 3000);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      };
      r.onsuccess = () => {
        clearTimeout(timer);
        if (settled) r.result.close();
        else {
          settled = true;
          res(r.result);
        }
      };
      r.onerror = r.onblocked = () => {
        clearTimeout(timer);
        settled = true;
        rej(r.error ?? new Error("Device storage is blocked"));
      };
    });
    dbp.catch(() => {
      memory = memory ?? new Map();
    });
  }
  return dbp;
}

function write(db: IDBDatabase, operation: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const timer = setTimeout(() => {
      try {
        t.abort();
      } catch {
        /* already ended */
      }
      reject(new Error("Device storage write timed out"));
    }, 3000);
    t.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    t.onerror = t.onabort = () => {
      clearTimeout(timer);
      reject(t.error);
    };
    try {
      operation(t.objectStore(STORE));
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

function emit() {
  version++;
  for (const f of listeners) f();
}
export function subscribeRecorder(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}
export const recorderVersion = () => version;

export async function putRecord(r: FlightRecord): Promise<void> {
  if (!recorderAvailable()) return;
  const v = RecordSchema.safeParse(r);
  if (!v.success) {
    console.warn("Recorder rejected an invalid record");
    return;
  }
  v.data = sanitizeRecord(v.data);
  try {
    const db = await open();
    await write(db, (s) => {
      s.put(v.data);
    });
    memory?.delete(v.data.id);
  } catch {
    memory = memory ?? new Map();
    memory.set(v.data.id, v.data);
  }
  emit();
}

export async function listRecords(): Promise<FlightRecord[]> {
  if (!recorderAvailable()) return [];
  let all: FlightRecord[] = [];
  try {
    const db = await open();
    all = await new Promise<FlightRecord[]>((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).getAll();
      const timer = setTimeout(() => rej(new Error("Device storage read timed out")), 3000);
      q.onsuccess = () => {
        clearTimeout(timer);
        res(q.result as FlightRecord[]);
      };
      q.onerror = () => {
        clearTimeout(timer);
        rej(q.error);
      };
    });
  } catch {
    memory = memory ?? new Map();
  }
  const merged = new Map<string, FlightRecord>();
  for (const r of [...all, ...(memory?.values() ?? [])]) {
    const valid = RecordSchema.safeParse(r);
    if (!valid.success) continue;
    const clean = sanitizeRecord(valid.data),
      previous = merged.get(clean.id);
    if (!previous || clean.updatedAt >= previous.updatedAt) merged.set(clean.id, clean);
  }
  const sorted = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // Wallet evidence and unresolved actions are never automatically evicted.
  let facts = 0;
  const retained: FlightRecord[] = [];
  for (const r of sorted) {
    if (
      r.kind === "wallet-action" ||
      r.status === "open" ||
      r.status === "unknown" ||
      facts++ < MAX
    )
      retained.push(r);
    else await deleteRecord(r.id, false);
  }
  return retained;
}

export async function getRecord(id: string): Promise<FlightRecord | null> {
  return (await listRecords()).find((r) => r.id === id) ?? null;
}

export async function deleteRecord(id: string, notify = true): Promise<void> {
  try {
    const db = await open();
    await write(db, (s) => {
      s.delete(id);
    });
  } catch (e) {
    if (!memory?.has(id))
      throw new Error("Couldn't remove this record from device storage", { cause: e });
  }
  memory?.delete(id);
  if (notify) emit();
}

/* ---------------- facts (proposals, reviews, handoffs) ---------------- */

type FactInput = {
  kind: FlightRecord["kind"];
  title: string;
  route: string;
  cluster: string;
  wallet?: string;
  links?: FlightRecord["links"];
  context?: FlightRecord["context"];
  detail?: string;
  id?: string;
  status?: FlightRecord["status"];
};
export function recordFact(o: FactInput): Promise<string> {
  const id = o.id ?? newId(o.kind === "proposal" ? "prop" : o.kind === "review" ? "rev" : "fact");
  const work = (factWrites.get(id) ?? Promise.resolve(id))
    .catch(() => id)
    .then(() => writeFact({ ...o, id }));
  factWrites.set(id, work);
  void work
    .finally(() => {
      if (factWrites.get(id) === work) factWrites.delete(id);
    })
    .catch(() => {});
  return work;
}
async function writeFact(o: FactInput & { id: string }): Promise<string> {
  const now = Date.now();
  const id = o.id;
  const prev = await getRecord(id);
  const ctx: FlightRecord["context"] = {};
  for (const [k, v] of Object.entries(o.context ?? {}).slice(0, 40))
    ctx[k.slice(0, 60)] = typeof v === "string" ? redact(v) : v;
  await putRecord({
    v: 1,
    id,
    kind: o.kind,
    provenance: "this-device",
    createdAt: prev?.createdAt ?? now,
    updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
    route: o.route.slice(0, 80),
    cluster: o.cluster,
    rpc: "none",
    wallet: o.wallet ?? "",
    title: redact(o.title).slice(0, 160),
    status: o.status ?? "info",
    links: { ...(prev?.links ?? {}), ...(o.links ?? {}) },
    context: { ...(prev?.context ?? {}), ...ctx },
    steps: [],
    timeline: [
      ...(prev?.timeline ?? []),
      { at: now, event: o.kind, detail: redact(o.detail ?? o.title) },
    ].slice(-MAX_TIMELINE_EVENTS),
    postState: [],
  });
  return id;
}

/* ---------------- wallet actions (from the shared runner) ---------------- */

export interface Evidence {
  title?: string;
  links?: FlightRecord["links"];
  context?: FlightRecord["context"];
}

export function startWalletRecord(o: {
  route: string;
  cluster: string;
  rpc: "relay" | "custom";
  wallet: string;
  labels: string[];
  evidence?: Evidence;
}) {
  const id = newId("tx");
  const now = Date.now();
  let rec: FlightRecord = {
    v: 1,
    id,
    kind: "wallet-action",
    provenance: "this-device",
    createdAt: now,
    updatedAt: now,
    route: o.route.slice(0, 80),
    cluster: o.cluster,
    rpc: o.rpc,
    wallet: o.wallet,
    title: redact(o.evidence?.title ?? o.labels[0] ?? "Wallet action").slice(0, 160),
    status: "open",
    links: o.evidence?.links ?? {},
    context: o.evidence?.context ?? {},
    steps: [],
    timeline: [
      { at: now, event: "started", detail: `${o.labels.length} step(s) prepared from ${o.route}` },
    ],
    postState: [],
  };
  let chain: Promise<void> = putRecord(rec);
  return {
    id,
    update(steps: TxStep[]) {
      const at = Date.now();
      const next = stepsFromRunner(steps, at, rec.steps);
      const ev = phaseEvents(rec.steps, next);
      const status = statusFromSteps(steps);
      if (!ev.length && status === rec.status && rec.context["totalSteps"] === steps.length) return;
      rec = {
        ...rec,
        steps: next,
        status,
        updatedAt: Math.max(at, rec.updatedAt + 1),
        context: {
          ...Object.fromEntries(
            Object.entries(rec.context)
              .filter(([k]) => k !== "totalSteps" && k !== "omittedSteps")
              .slice(0, 38),
          ),
          totalSteps: steps.length,
          omittedSteps: Math.max(0, steps.length - MAX_RECORDED_STEPS),
        },
        timeline: [...rec.timeline, ...ev].slice(-MAX_TIMELINE_EVENTS),
      };
      const snap = rec;
      chain = chain.then(() => putRecord(snap));
    },
    async addPostState(p: FlightRecord["postState"][number]) {
      rec = {
        ...rec,
        postState: [...rec.postState.filter((x) => x.signature !== p.signature), p].slice(
          0,
          MAX_RECORDED_STEPS,
        ),
        updatedAt: Math.max(Date.now(), rec.updatedAt + 1),
        timeline: [
          ...rec.timeline,
          {
            at: Date.now(),
            event: p.slot === null ? "metadata unavailable" : "transaction metadata read",
            detail:
              p.slot === null
                ? p.note
                : `${p.signature.slice(0, 12)}… via getTransaction${p.err ? ` (failed: ${p.err})` : ""}`,
          },
        ].slice(-MAX_TIMELINE_EVENTS),
      };
      const snap = rec;
      chain = chain.then(() => putRecord(snap));
      await chain;
    },
    flush: () => chain,
  };
}

/** Reconciliation appends to the record holding the signature; never resends. */
export async function reconcileSignature(
  signature: string,
  outcome: "confirmed" | "failed" | "expired" | "pending" | "unknown",
  detail: string,
  fallback?: PendingTx,
) {
  const all = await listRecords();
  const now = Date.now();
  let rec = all.find(
    (r) =>
      r.kind === "wallet-action" &&
      r.provenance === "this-device" &&
      (!fallback || (r.cluster === fallback.cluster && r.wallet === fallback.wallet)) &&
      r.steps.some((s) => s.signature === signature),
  );
  if (!rec && fallback) {
    rec = {
      v: 1,
      id: newId("tx"),
      kind: "wallet-action",
      provenance: "this-device",
      createdAt: fallback.createdAt,
      updatedAt: now,
      route: "(recovered)",
      cluster: fallback.cluster,
      rpc: fallback.rpc,
      wallet: fallback.wallet,
      title: redact(fallback.label),
      status: "unknown",
      links: {},
      context: { recoveredFrom: "unresolved-signature store" },
      steps: [
        { label: redact(fallback.label), phase: "unknown", signature, at: fallback.createdAt },
      ],
      timeline: [
        {
          at: now,
          event: "recovered",
          detail: "Rebuilt from the unresolved-signature list after the original page was lost.",
        },
      ],
      postState: [],
    };
  }
  if (!rec) return;
  const steps = rec.steps.map((s) =>
    s.signature === signature &&
    (outcome === "confirmed" || outcome === "failed" || outcome === "expired")
      ? { ...s, phase: outcome, at: now }
      : s,
  );
  await putRecord({
    ...rec,
    steps,
    status: statusFromSteps(steps),
    updatedAt: now,
    timeline: [
      ...rec.timeline,
      { at: now, event: `reconcile: ${outcome}`, detail: redact(detail) },
    ].slice(-MAX_TIMELINE_EVENTS),
  });
}

/** Ensure every unresolved signature in the pending store has a recorder entry. */
export async function adoptPending(pending: PendingTx[]) {
  if (!pending.length) return;
  const all = await listRecords();
  for (const p of pending)
    if (
      !all.some(
        (r) =>
          r.provenance === "this-device" &&
          r.cluster === p.cluster &&
          r.wallet === p.wallet &&
          r.steps.some((s) => s.signature === p.signature),
      )
    )
      await reconcileSignature(p.signature, "unknown", "Unresolved at load", p);
}

/* ---------------- cloud copy (optional, signed-in, RLS-private) ---------------- */

export async function syncToCloud(
  records: FlightRecord[],
): Promise<{ pushed: number; pulled: number; error?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      syncPrivateRecords(records, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Cloud sync timed out; device evidence is retained"));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function syncPrivateRecords(
  records: FlightRecord[],
  signal: AbortSignal,
): Promise<{ pushed: number; pulled: number; error?: string }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return { pushed: 0, pulled: 0, error: "Sign in to sync" };
  const remote = new Map<string, FlightRecord>();
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase
      .from("recorder_records")
      .select("id,record")
      .eq("user_id", u.user.id)
      .order("id", { ascending: true })
      .abortSignal(signal)
      .range(start, start + 999);
    if (error) return { pushed: 0, pulled: 0, error: redact(error.message) };
    for (const row of data ?? []) {
      const p = RecordSchema.safeParse(row.record);
      if (p.success && row.id === p.data.id) remote.set(row.id, sanitizeRecord(p.data));
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  const local = records
    .filter(
      (r) =>
        r.provenance === "this-device" &&
        (!remote.has(r.id) || remote.get(r.id)!.updatedAt < r.updatedAt),
    )
    .map(sanitizeRecord);
  let pushed = 0;
  for (let i = 0; i < local.length; i += 100) {
    const { data: saved, error } = await supabase
      .from("recorder_records")
      .upsert(
        local.slice(i, i + 100).map((r) => ({
          user_id: u.user!.id,
          id: r.id,
          record: r as never,
          updated_at: new Date(r.updatedAt).toISOString(),
        })),
      )
      .select("id")
      .abortSignal(signal);
    if (error) return { pushed, pulled: 0, error: redact(error.message) };
    pushed += saved?.length ?? 0;
  }
  const have = new Map(records.map((r) => [r.id, r]));
  let pulled = 0;
  for (const r of remote.values()) {
    const cur = have.get(r.id);
    if (!cur || cur.updatedAt < r.updatedAt) {
      await putRecord({
        ...r,
        provenance: cur?.provenance === "this-device" ? "this-device" : "cloud",
      });
      pulled++;
    }
  }
  return { pushed, pulled };
}

/** Durable-only mission journal. Every mutation checks the actual stored revision. */
import {
  ConductorMission,
  MissionPolicyRevision,
  MissionSnapshot,
  MISSION_MAX_SAMPLES,
  missionPolicyDigest,
  missionSampleRecordId,
  missionPolicyRecordId,
  analyzeMissionExport,
  exportMission,
} from "./conductor";
const DB = "studio-loco-conductor",
  STORE = "missions";
export const BUDGETS = "budgets",
  OPERATIONS = "operations";
let opening: Promise<IDBDatabase> | null = null,
  channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function connect() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = () => listeners.forEach((f) => f());
  }
}
function changed() {
  connect();
  listeners.forEach((f) => f());
  channel?.postMessage({ changed: true });
}
export function subscribeConductor(fn: () => void) {
  connect();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function open() {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Persistent device storage is unavailable; no mission was saved."));
      return;
    }
    const request = indexedDB.open(DB, 2);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Conductor storage timed out."));
    }, 3000);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BUDGETS)) db.createObjectStore(BUDGETS, { keyPath: "key" });
      if (!db.objectStoreNames.contains(OPERATIONS)) db.createObjectStore(OPERATIONS, { keyPath: "id" });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) request.result.close();
      else {
        settled = true;
        request.result.onversionchange = () => {
          request.result.close();
          opening = null;
        };
        resolve(request.result);
      }
    };
    request.onerror = request.onblocked = () => {
      clearTimeout(timer);
      settled = true;
      reject(new Error("Conductor storage is blocked."));
    };
  });
  void opening.catch(() => {
    opening = null;
  });
  return opening;
}
async function tx<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore, done: (v: T) => void, fail: (message: string) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let value: T,
      reason = "Conductor storage operation failed.";
    const timer = setTimeout(() => {
      reason = "Conductor storage operation timed out.";
      try {
        t.abort();
      } catch {}
      reject(new Error(reason));
    }, 3000);
    t.oncomplete = () => {
      clearTimeout(timer);
      resolve(value);
    };
    t.onerror = t.onabort = () => {
      clearTimeout(timer);
      reject(new Error(reason));
    };
    try {
      body(
        t.objectStore(STORE),
        (v) => {
          value = v;
        },
        (message) => {
          reason = message;
          t.abort();
        },
      );
    } catch (e) {
      reason = e instanceof Error ? e.message : reason;
      t.abort();
    }
  });
}
/** One atomic readwrite/readonly transaction across several stores in the same database. */
export async function ledgerTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (t: IDBTransaction, done: (v: T) => void, fail: (message: string) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(stores, mode);
    } catch {
      reject(new Error("Conductor ledger storage is unavailable."));
      return;
    }
    let value: T,
      reason = "Conductor ledger storage failed; nothing was reserved.";
    const timer = setTimeout(() => {
      reason = "Conductor ledger storage timed out; nothing was reserved.";
      try {
        t.abort();
      } catch {}
      reject(new Error(reason));
    }, 3000);
    t.oncomplete = () => {
      clearTimeout(timer);
      resolve(value);
    };
    t.onerror = t.onabort = () => {
      clearTimeout(timer);
      const e = t.error;
      reject(new Error(e?.name === "QuotaExceededError" ? "Device storage is full; nothing was saved." : reason));
    };
    try {
      body(t, (v) => (value = v), (m) => {
        reason = m;
        t.abort();
      });
    } catch (e) {
      reason = e instanceof Error ? e.message : reason;
      t.abort();
    }
  });
}
export const notifyConductor = changed;
export const listMissions = () =>
  tx<ConductorMission[]>("readonly", (s, done, fail) => {
    const r = s.getAll();
    r.onsuccess = () => {
      try {
        done(
          r.result.map((v) => ConductorMission.parse(v)).sort((a, b) => b.updatedAt - a.updatedAt),
        );
      } catch {
        fail("Stored mission data is invalid.");
      }
    };
  });
export const getMission = (id: string) =>
  tx<ConductorMission | null>("readonly", (s, done, fail) => {
    const r = s.get(id);
    r.onsuccess = () => {
      try {
        done(r.result ? ConductorMission.parse(r.result) : null);
      } catch {
        fail("Stored mission is invalid.");
      }
    };
  });
export async function saveNewMission(input: ConductorMission) {
  const m = ConductorMission.parse(input);
  await analyzeMissionExport(exportMission(m));
  const p = m.policies[0]!,
    sample = m.samples[0];
  if (
    m.revision !== 1 ||
    m.policies.length !== 1 ||
    p.revision !== 1 ||
    !sample ||
    m.samples.length !== 1 ||
    m.omittedSamples !== 0 ||
    m.gaps.length ||
    m.omittedGaps ||
    m.recorderLinks.length ||
    Date.now() < sample.snapshot.observedAt ||
    Date.now() - sample.snapshot.startedAt > p.policy.maxAgeMs ||
    p.policy.expiresAt <= Date.now()
  )
    throw new Error(
      "Start a mission with a newly sealed policy and fresh baseline; history cannot be backfilled.",
    );
  const out = await tx<ConductorMission>("readwrite", (s, done, fail) => {
    const count = s.count();
    count.onsuccess = () => {
      if (count.result >= 20) {
        fail("20 missions are saved. Export and remove one before creating another.");
        return;
      }
      const r = s.add(m);
      r.onsuccess = () => done(m);
    };
  });
  changed();
  return out;
}
async function mutate(
  id: string,
  expected: number | null,
  fn: (m: ConductorMission) => ConductorMission | null,
) {
  const out = await tx<ConductorMission | null>("readwrite", (s, done, fail) => {
    const r = s.get(id);
    r.onsuccess = () => {
      try {
        if (!r.result) throw new Error("This mission was removed. It will not be recreated.");
        const before = ConductorMission.parse(r.result);
        if (expected !== null && before.revision !== expected)
          throw new Error("This mission changed in another tab. Reload before updating.");
        const candidate = fn(before);
        if (!candidate) {
          done(before);
          return;
        }
        const next = ConductorMission.parse({
          ...candidate,
          revision: before.revision + 1,
          updatedAt: Math.max(Date.now(), before.updatedAt + 1),
        });
        s.put(next);
        done(next);
      } catch (e) {
        fail(e instanceof Error ? e.message : "Mission mutation failed.");
      }
    };
  });
  changed();
  return out;
}
export function appendMissionObservation(id: string, revision: number, input: MissionSnapshot) {
  const snapshot = MissionSnapshot.parse(input);
  return mutate(id, revision, (m) => {
    const p = m.policies.at(-1)!,
      previous = m.samples.at(-1),
      now = Date.now();
    if (
      !same(snapshot.scope, p.policy.scope) ||
      snapshot.startedAt < p.sealedAt ||
      now < snapshot.observedAt ||
      now - snapshot.startedAt > p.policy.maxAgeMs ||
      now >= p.policy.expiresAt
    )
      throw new Error("The read is stale, expired or differs from the current sealed scope.");
    if (
      previous &&
      (snapshot.slot < previous.snapshot.slot || snapshot.startedAt < previous.snapshot.observedAt)
    )
      throw new Error("Observation order moved backwards.");
    const seq = (previous?.seq ?? m.omittedSamples) + 1;
    const samples = [
      ...m.samples,
      {
        seq,
        policyRevision: p.revision,
        policyDigest: p.digest,
        recordedAt: Math.max(now, (previous?.recordedAt ?? 0) + 1),
        snapshot,
        recordId: missionSampleRecordId(id, seq),
      },
    ];
    const dropped = Math.max(0, samples.length - MISSION_MAX_SAMPLES),
      retained = samples.slice(dropped);
    const keep = new Set([
      ...m.policies.map((p) => missionPolicyRecordId(id, p.revision)),
      ...retained.map((s) => s.recordId),
    ]);
    return {
      ...m,
      samples: retained,
      omittedSamples: m.omittedSamples + dropped,
      recorderLinks: m.recorderLinks.filter((r) => keep.has(r.recordId)),
      lastError: null,
      lastAttempt: now,
    };
  });
}
export async function appendMissionPolicy(
  id: string,
  revision: number,
  input: MissionPolicyRevision,
) {
  const p = MissionPolicyRevision.parse(input);
  if (p.digest !== (await missionPolicyDigest(p.policy))) throw new Error("Policy digest differs.");
  return mutate(id, revision, (m) => {
    const prior = m.policies.at(-1)!;
    if (m.policies.length >= 20)
      throw new Error(
        "20 immutable revisions are retained. Start a new mission for additional policy versions.",
      );
    if (
      p.revision !== prior.revision + 1 ||
      p.sealedAt <= prior.sealedAt ||
      p.sealedAt < (m.samples.at(-1)?.recordedAt ?? m.createdAt) ||
      !same(p.policy.scope, prior.policy.scope) ||
      p.policy.expiresAt <= Date.now() ||
      p.policy.expiresAt > Date.now() + 30 * 86_400_000
    )
      throw new Error(
        "A new revision must preserve exact scope and use a new valid seal time and expiry.",
      );
    return { ...m, policies: [...m.policies, p], status: "paused", lastError: null };
  });
}
export const setMissionStatus = (id: string, revision: number, status: "paused" | "monitoring") =>
  mutate(id, revision, (m) => {
    if (status === "monitoring" && Date.now() >= m.policies.at(-1)!.policy.expiresAt)
      throw new Error("Seal a new policy revision before resuming an expired mission.");
    return { ...m, status };
  });
export const noteMissionError = (id: string, revision: number, error: string) =>
  mutate(id, null, (m) => {
    if (m.revision !== revision) return null;
    const gaps = [
      ...m.gaps,
      {
        at: Date.now(),
        afterSeq: m.samples.at(-1)?.seq ?? m.omittedSamples,
        reason: error.slice(0, 300) || "Read unavailable",
      },
    ];
    return {
      ...m,
      lastError: error.slice(0, 300),
      lastAttempt: Date.now(),
      gaps: gaps.slice(-120),
      omittedGaps: m.omittedGaps + Math.max(0, gaps.length - 120),
    };
  });
export const acknowledgeMissionFact = (id: string, recordId: string) =>
  mutate(id, null, (m) => {
    const valid =
      m.samples.some((s) => s.recordId === recordId) ||
      m.policies.some((p) => missionPolicyRecordId(id, p.revision) === recordId);
    if (!valid || m.recorderLinks.some((r) => r.recordId === recordId)) return null;
    return { ...m, recorderLinks: [...m.recorderLinks, { recordId, savedAt: Date.now() }] };
  });
export async function removeMission(id: string, revision: number) {
  await ledgerTx<void>([STORE, OPERATIONS], "readwrite", (t, done, fail) => {
    const s = t.objectStore(STORE),
      r = s.get(id);
    r.onsuccess = () => {
      if (!r.result || r.result.revision !== revision) {
        fail("Mission changed or was already removed. Reload before removing.");
        return;
      }
      const ops = t.objectStore(OPERATIONS).getAll();
      ops.onsuccess = () => {
        const pending = (ops.result as { missionId: string; op: { state: string } }[]).filter(
          (o) => o.missionId === id && !["confirmed", "failed", "rejected", "expired"].includes(o.op.state),
        );
        if (pending.length) {
          fail(`This mission has ${pending.length} unresolved operation(s). Reconcile them before removing it.`);
          return;
        }
        s.delete(id);
        done(undefined);
      };
    };
  });
  changed();
}

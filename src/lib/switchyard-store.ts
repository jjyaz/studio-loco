/** Durable, bounded local experiments. Atomic stored-row CAS; no memory fallback. */
import {
  SwitchyardExperiment,
  SWITCHYARD_MAX_EXPERIMENTS,
  SWITCHYARD_MAX_GAP_MS,
  retainedDecisions,
  type ShadowExperiment,
} from "./switchyard";
const DB = "studio-loco-switchyard",
  STORE = "experiments";
let opening: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
function notify() {
  for (const f of listeners) f();
}
function changed() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = notify;
  }
  notify();
  channel?.postMessage({ changed: true });
}
export function subscribeSwitchyard(fn: () => void) {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = notify;
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Persistent device storage is unavailable. No experiment was saved."));
      return;
    }
    const r = indexedDB.open(DB, 1);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Switchyard storage timed out."));
    }, 3000);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => {
      clearTimeout(timer);
      if (settled) r.result.close();
      else {
        settled = true;
        r.result.onversionchange = () => {
          r.result.close();
          opening = null;
        };
        resolve(r.result);
      }
    };
    r.onerror = r.onblocked = () => {
      clearTimeout(timer);
      settled = true;
      reject(new Error("Switchyard storage is blocked."));
    };
  });
  void opening.catch(() => {
    opening = null;
  });
  return opening;
}
function tx<T>(
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore, done: (value: T) => void, fail: (message: string) => void) => void,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode),
          s = t.objectStore(STORE);
        let value: T,
          reason = "Switchyard storage operation failed.";
        const timer = setTimeout(() => {
          reason = "Switchyard storage operation timed out.";
          try {
            t.abort();
          } catch {}
          reject(new Error(reason));
        }, 3000);
        t.oncomplete = () => {
          clearTimeout(timer);
          resolve(value);
        };
        t.onabort = t.onerror = () => {
          clearTimeout(timer);
          reject(new Error(reason));
        };
        const fail = (m: string) => {
          reason = m;
          t.abort();
        };
        try {
          body(
            s,
            (v) => {
              value = v;
            },
            fail,
          );
        } catch (e) {
          fail(e instanceof Error ? e.message : reason);
        }
      }),
  );
}
export async function listShadowExperiments() {
  const rows = await tx<unknown[]>("readonly", (s, done) => {
    const r = s.getAll();
    r.onsuccess = () => done(r.result);
  });
  if (rows.length > SWITCHYARD_MAX_EXPERIMENTS)
    throw new Error("Switchyard experiment limit exceeded.");
  return rows.map((r) => SwitchyardExperiment.parse(r)).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getShadowExperiment(id: string) {
  const value = await tx<unknown>("readonly", (s, done) => {
    const r = s.get(id);
    r.onsuccess = () => done(r.result);
  });
  return value === undefined ? null : SwitchyardExperiment.parse(value);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Compare against actual stored content, not a caller's possibly altered parent. */
function assertUpdate(before: ShadowExperiment, next: ShadowExperiment) {
  for (const key of [
    "id",
    "evidenceId",
    "suppliedId",
    "provenance",
    "createdAt",
    "continuityId",
    "source",
    "seed",
    "policy",
  ] as const)
    if (!same(before[key], next[key]))
      throw new Error("Original source and sealed policy are immutable. Start a new experiment.");
  if (before.provenance === "import" && !same(before.samples, next.samples))
    throw new Error("Supplied observations cannot be promoted or rewritten.");
  const total = before.omittedSamples + before.samples.length;
  const nextTotal = next.omittedSamples + next.samples.length;
  if (nextTotal !== total && nextTotal !== total + 1)
    throw new Error("Observations must append one at a time.");
  const kept = new Map(next.samples.map((s) => [s.seq, s]));
  for (const old of before.samples) {
    const current = kept.get(old.seq);
    if (current && !same(old, current))
      throw new Error("Retained observations and decisions are immutable.");
    if (!current && old.seq > next.omittedSamples)
      throw new Error("Only the expired observation prefix can be dropped.");
  }
  if (nextTotal === total && !same(before.samples, next.samples))
    throw new Error("Retained history cannot be replaced.");
  if (next.status !== before.status) throw new Error("Use the atomic pause/resume operation.");
  if (nextTotal === total + 1) {
    if (before.provenance !== "this-device" || before.status !== "running")
      throw new Error("This experiment is no longer running.");
    const latest = next.samples.at(-1)!;
    const prev = before.samples.at(-1),
      point = prev ?? before.seed;
    const expectedGap =
      before.pendingReset !== "none"
        ? before.pendingReset
        : latest.observedAt - point.observedAt > SWITCHYARD_MAX_GAP_MS
          ? "missed-interval"
          : "none";
    if (latest.gapReason !== expectedGap)
      throw new Error("Observation gaps must retain their original cause.");
    for (let i = 0; i < 3; i++) {
      if (
        !same(latest.tracks[i]!.before, prev?.tracks[i]?.after ?? before.seed.actualRange) ||
        latest.tracks[i]!.lastActionBefore !== (prev?.tracks[i]?.lastActionAfter ?? null)
      )
        throw new Error("A later observation cannot change an earlier virtual range.");
    }
  }
  const retained = new Set(retainedDecisions(next).map((d) => d.recordId));
  for (const l of before.recorderLinks) {
    if (retained.has(l.recordId) && !next.recorderLinks.some((n) => same(n, l)))
      throw new Error("Retained Recorder acknowledgements cannot be rewritten.");
  }
}
export async function saveShadowExperiment(input: ShadowExperiment, parent?: ShadowExperiment) {
  const candidate = SwitchyardExperiment.parse(input);
  const next = await tx<ShadowExperiment>("readwrite", (s, done, fail) => {
    const r = s.get(candidate.id);
    r.onsuccess = () => {
      try {
        if (r.result) {
          const old = SwitchyardExperiment.parse(r.result);
          if (!parent || old.id !== parent.id || old.revision !== parent.revision)
            throw new Error("This experiment changed in another tab. Reload before updating.");
          assertUpdate(old, candidate);
          const value = SwitchyardExperiment.parse({
            ...candidate,
            revision: old.revision + 1,
            updatedAt: Math.max(Date.now(), candidate.updatedAt, old.updatedAt + 1),
          });
          s.put(value);
          done(value);
        } else {
          if (parent) throw new Error("This experiment was removed in another tab.");
          if (
            candidate.provenance === "this-device" &&
            (candidate.samples.length ||
              candidate.omittedSamples ||
              Date.now() < candidate.seed.observedAt ||
              Date.now() - candidate.seed.observedAt > 150_000)
          )
            throw new Error("Start from a fresh source; device history cannot be backfilled.");
          const n = s.count();
          n.onsuccess = () => {
            if (n.result >= SWITCHYARD_MAX_EXPERIMENTS)
              fail("20 experiments are already saved. Export and remove one first.");
            else {
              s.add(candidate);
              done(candidate);
            }
          };
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : "Experiment write failed.");
      }
    };
  });
  changed();
  return next;
}
async function mutate(id: string, change: (e: ShadowExperiment) => ShadowExperiment | null) {
  const out = await tx<ShadowExperiment | null>("readwrite", (s, done, fail) => {
    const r = s.get(id);
    r.onsuccess = () => {
      try {
        if (!r.result) {
          done(null);
          return;
        }
        const old = SwitchyardExperiment.parse(r.result);
        const candidate = change(old);
        if (!candidate) {
          done(old);
          return;
        }
        const next = SwitchyardExperiment.parse({
          ...candidate,
          revision: old.revision + 1,
          updatedAt: Math.max(Date.now(), candidate.updatedAt, old.updatedAt + 1),
        });
        s.put(next);
        done(next);
      } catch (e) {
        fail(e instanceof Error ? e.message : "Experiment update failed.");
      }
    };
  });
  changed();
  return out;
}
/** Pause is authoritative and cannot lose observations committed by another tab. */
export function setShadowStatus(id: string, status: "running" | "paused") {
  return mutate(id, (e) => {
    if (e.provenance !== "this-device") throw new Error("Imported evidence cannot be resumed.");
    return { ...e, status, pendingReset: "paused" };
  });
}
export function noteShadowReadError(id: string, lastSeq: number, message: string, at = Date.now()) {
  return mutate(id, (e) =>
    e.provenance !== "this-device" ||
    e.status !== "running" ||
    (e.samples.at(-1)?.seq ?? 0) !== lastSeq
      ? null
      : {
          ...e,
          lastAttempt: at,
          lastError: message.slice(0, 350),
          pendingReset: "read-error",
        },
  );
}
export function acknowledgeShadowFact(id: string, recordId: string, at = Date.now()) {
  return mutate(id, (e) => {
    if (
      e.provenance !== "this-device" ||
      !retainedDecisions(e).some((d) => d.recordId === recordId) ||
      e.recorderLinks.some((l) => l.recordId === recordId)
    )
      return null;
    return {
      ...e,
      recorderLinks: [...e.recorderLinks, { recordId, savedAt: at }],
      recorderError: null,
    };
  });
}
export function noteShadowRecorderError(id: string, message: string) {
  return mutate(id, (e) =>
    e.provenance !== "this-device" ? null : { ...e, recorderError: message.slice(0, 350) },
  );
}
export async function removeShadowExperiment(parent: ShadowExperiment) {
  await tx<void>("readwrite", (s, done, fail) => {
    const r = s.get(parent.id);
    r.onsuccess = () => {
      if (!r.result || SwitchyardExperiment.parse(r.result).revision !== parent.revision)
        fail("Experiment changed in another tab. Reload before removing.");
      else {
        s.delete(parent.id);
        done();
      }
    };
  });
  changed();
}

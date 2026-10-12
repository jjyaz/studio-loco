/** Device IndexedDB for strategy continuity. Atomic revision CAS across tabs; no pretend fallback. */
import {
  MAX_STRATEGIES,
  StrategySchema,
  migrateJourney,
  assertStrategyUpdate,
  type Strategy,
} from "./continuity";
import type { Journey } from "./journey";

const DB = "studio-loco-continuity",
  STORE = "strategies";
const RETIRED = "retired-origins";
let opening: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
function wire() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = emit;
  }
}
function changed() {
  wire();
  emit();
  channel?.postMessage({ changed: true });
}
export function subscribeContinuity(f: () => void) {
  wire();
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}
function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Persistent device storage is unavailable. No strategy was saved."));
      return;
    }
    const r = indexedDB.open(DB, 2);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Strategy storage timed out."));
    }, 3000);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE))
        r.result.createObjectStore(STORE, { keyPath: "id" });
      if (!r.result.objectStoreNames.contains(RETIRED))
        r.result.createObjectStore(RETIRED, { keyPath: "id" });
    };
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
      reject(new Error("Strategy storage is blocked."));
    };
  });
  void opening.catch(() => {
    opening = null;
  });
  return opening;
}
function tx<T>(
  mode: IDBTransactionMode,
  body: (
    s: IDBObjectStore,
    fail: (m: string) => void,
    done: (v: T) => void,
    retired: IDBObjectStore,
  ) => void,
  label: string,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction([STORE, RETIRED], mode),
          s = t.objectStore(STORE);
        let reason = `Could not ${label}.`,
          value: T;
        const timer = setTimeout(() => {
          reason = `Strategy ${label} timed out.`;
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
        body(
          s,
          (m) => {
            reason = m;
            t.abort();
          },
          (v) => {
            value = v;
          },
          t.objectStore(RETIRED),
        );
      }),
  );
}
export async function listStrategies(): Promise<Strategy[]> {
  const rows = await tx<unknown[]>(
    "readonly",
    (s, _f, done) => {
      const r = s.getAll();
      r.onsuccess = () => done(r.result);
    },
    "read strategies",
  );
  if (rows.length > MAX_STRATEGIES) throw new Error("Strategy limit exceeded.");
  return rows.map((r) => StrategySchema.parse(r)).sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Compare-and-swap: a parent revision must match exactly; new IDs never overwrite. */
export async function saveStrategy(input: Strategy, parent?: Strategy): Promise<Strategy> {
  const c = StrategySchema.parse(input);
  if (parent && (parent.id !== c.id || parent.provenance !== c.provenance))
    throw new Error("Strategy identity or provenance cannot change.");
  if (parent && JSON.stringify(parent.origin) !== JSON.stringify(c.origin))
    throw new Error("Original blueprint origin is immutable.");
  if (
    parent &&
    parent.chapters.some((p) => !c.chapters.some((x) => x.id === p.id)) &&
    c.omittedChapters === parent.omittedChapters
  )
    throw new Error(
      "Lifecycle chapters are immutable; they may only be appended or retired by retention.",
    );
  const next = StrategySchema.parse({
    ...c,
    revision: parent ? parent.revision + 1 : 1,
    updatedAt: Math.max(Date.now(), (parent?.updatedAt ?? 0) + 1),
  });
  await tx<void>(
    "readwrite",
    (s, fail) => {
      const r = s.get(next.id);
      r.onsuccess = () => {
        if (r.result) {
          const parsed = StrategySchema.safeParse(r.result);
          if (!parsed.success)
            return fail("Stored strategy failed validation. Earlier evidence was not overwritten.");
          const existing = parsed.data;
          if (!parent || existing.revision !== parent.revision)
            return fail("This strategy changed in another tab. Reload before updating.");
          try {
            assertStrategyUpdate(existing, next);
          } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
          }
          s.put(next);
        } else {
          if (parent) return fail("This strategy was removed in another tab.");
          const n = s.count();
          n.onsuccess = () =>
            n.result >= MAX_STRATEGIES
              ? fail(
                  `${MAX_STRATEGIES} strategies are already stored. Export and remove one first.`,
                )
              : s.add(next);
        }
      };
    },
    "save strategy",
  );
  changed();
  return next;
}
export async function removeStrategy(parent: Strategy) {
  await tx<void>(
    "readwrite",
    (s, fail, _done, retired) => {
      const r = s.get(parent.id);
      r.onsuccess = () => {
        if (
          !r.result ||
          !StrategySchema.safeParse(r.result).success ||
          StrategySchema.parse(r.result).revision !== parent.revision
        )
          fail("Strategy changed in another tab. Reload before removing.");
        else {
          s.delete(parent.id);
          if (parent.provenance === "verified") retired.put({ id: parent.id });
        }
      };
    },
    "remove strategy",
  );
  changed();
}

/** Explicit user recovery of retired origins. No transaction or signature is replayed. */
export async function restoreOrigins(journeys: Journey[]) {
  const ids = journeys.map((j) => migrateJourney(j)?.id).filter((id): id is string => !!id);
  await tx<void>(
    "readwrite",
    (_s, _fail, _done, retired) => {
      ids.forEach((id) => retired.delete(id));
    },
    "restore origins",
  );
  return migrateJourneys(journeys);
}
/** Adds a strategy for every Foundry-linked v1 Journey that has none. v1 records are never modified. */
export async function migrateJourneys(journeys: Journey[]) {
  const existing = await listStrategies();
  const retired = new Set(
    await tx<IDBValidKey[]>(
      "readonly",
      (_s, _f, done, retired) => {
        const r = retired.getAllKeys();
        r.onsuccess = () => done(r.result);
      },
      "read retired origins",
    ),
  );
  let created = 0;
  for (const j of journeys) {
    const s = migrateJourney(j);
    if (!s || retired.has(s.id)) continue;
    const prior = existing.find(
      (e) =>
        e.provenance === "verified" &&
        e.accounts.some((a) => a.account === j.account && a.verification === "transaction"),
    );
    if (prior) {
      const conflicts = [...prior.conflicts];
      for (const o of [s.origin, ...s.conflicts]) {
        if (
          o &&
          (o.blueprintId !== prior.origin?.blueprintId ||
            o.revision !== prior.origin?.revision ||
            o.digest !== prior.origin?.digest) &&
          !conflicts.some(
            (x) =>
              x.blueprintId === o.blueprintId &&
              x.digest === o.digest &&
              x.revision === o.revision &&
              x.signature === o.signature,
          )
        )
          conflicts.push(o);
      }
      if (conflicts.length > 10)
        throw new Error("Origin conflict limit reached. Export this strategy before continuing.");
      if (conflicts.length !== prior.conflicts.length) {
        const saved = await saveStrategy({ ...prior, conflicts }, prior);
        existing[existing.indexOf(prior)] = saved;
      }
      continue;
    }
    try {
      existing.push(await saveStrategy(s));
      created++;
    } catch (e) {
      if (!/another tab/.test(String(e))) throw e;
    }
  }
  return created;
}

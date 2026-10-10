import { JourneySchema, MAX_JOURNEYS, journeyId, type Journey } from "./journey";
const DB = "studio-loco-journey",
  STORE = "accounts";
let opening: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
function emit() {
  for (const f of listeners) f();
}
function wire() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = emit;
  }
}
export function subscribeJourney(f: () => void) {
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
      reject(new Error("Persistent device storage is unavailable. No Journey was saved."));
      return;
    }
    const r = indexedDB.open(DB, 1);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Journey storage timed out."));
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
      reject(new Error("Journey storage is blocked."));
    };
  });
  void opening.catch(() => {
    opening = null;
  });
  return opening;
}
function checked(raw: unknown): Journey {
  const j = JourneySchema.parse(raw);
  if (j.id !== journeyId(j)) throw new Error("Journey identity failed validation.");
  for (let i = 0; i < j.snapshots.length; i++) {
    const s = j.snapshots[i]!,
      prev = j.snapshots[i - 1];
    if (
      s.kind !== j.kind ||
      s.checkedSlot < s.slot ||
      (prev && (s.slot < prev.checkedSlot || s.observedAt <= prev.observedAt))
    )
      throw new Error("Saved Journey observation sequence failed validation.");
  }
  return j;
}
export async function listJourneys(): Promise<Journey[]> {
  const db = await open();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly"),
      r = tx.objectStore(STORE).getAll();
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {}
      reject(new Error("Journey read timed out."));
    }, 3000);
    r.onsuccess = () => {
      clearTimeout(timer);
      resolve(r.result);
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not read Journeys."));
    };
  });
  if (rows.length > MAX_JOURNEYS) throw new Error("Journey account limit exceeded.");
  return rows.map(checked).sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Atomic compare-and-swap across tabs. Nothing falls back to a pretend durable memory store. */
export async function saveJourney(input: Journey, parent?: Journey): Promise<Journey> {
  const candidate = checked(input),
    db = await open();
  const next = {
    ...candidate,
    revision: parent ? parent.revision + 1 : 1,
    updatedAt: Math.max(Date.now(), (parent?.updatedAt ?? 0) + 1),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"),
      s = tx.objectStore(STORE);
    let reason = "Could not persist this Journey.";
    const timer = setTimeout(() => {
      reason = "Journey write timed out.";
      try {
        tx.abort();
      } catch {}
      reject(new Error(reason));
    }, 3000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      clearTimeout(timer);
      reject(new Error(reason));
    };
    const r = s.get(next.id);
    r.onsuccess = () => {
      if (r.result) {
        const existing = checked(r.result);
        if (
          !parent ||
          existing.revision !== parent.revision ||
          existing.owner !== next.owner ||
          existing.pool !== next.pool ||
          existing.kind !== next.kind
        ) {
          reason = "This Journey changed in another tab. Reload before updating.";
          tx.abort();
          return;
        }
        s.put(next);
      } else {
        if (parent) {
          reason = "This Journey was removed in another tab.";
          tx.abort();
          return;
        }
        const count = s.count();
        count.onsuccess = () => {
          if (count.result >= MAX_JOURNEYS) {
            reason = "100 accounts are already tracked. Export and remove a watch first.";
            tx.abort();
          } else s.add(next);
        };
      }
    };
  });
  wire();
  emit();
  channel?.postMessage({ changed: true });
  return next;
}
export async function removeJourney(parent: Journey) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"),
      s = tx.objectStore(STORE);
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {}
      reject(new Error("Journey removal timed out."));
    }, 3000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Journey changed in another tab. Reload before removing."));
    };
    const r = s.get(parent.id);
    r.onsuccess = () => {
      if (!r.result || checked(r.result).revision !== parent.revision) tx.abort();
      else s.delete(parent.id);
    };
  });
  wire();
  emit();
  channel?.postMessage({ changed: true });
}

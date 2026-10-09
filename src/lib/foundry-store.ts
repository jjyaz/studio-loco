import { blueprintDigest, parseBlueprint, type Blueprint } from "./foundry";
export interface SavedBlueprint {
  key: string;
  blueprint: Blueprint;
  digest: string;
  savedAt: number;
}
const DB = "studio-loco-foundry",
  STORE = "revisions",
  MAX = 200;
let opening: Promise<IDBDatabase> | null = null;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();
function notify() {
  for (const f of listeners) f();
}
function wire() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(DB);
    channel.onmessage = notify;
  }
}
export function subscribeFoundry(f: () => void) {
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
      reject(new Error("Persistent device storage is unavailable."));
      return;
    }
    const r = indexedDB.open(DB, 1);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Device storage did not open in time."));
    }, 3000);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore(STORE, { keyPath: "key" });
      s.createIndex("blueprintId", "blueprint.id");
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
      reject(new Error("Device storage is blocked."));
    };
  });
  void opening.catch(() => {
    opening = null;
  });
  return opening;
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Device library read timed out.")), 3000);
    r.onsuccess = () => {
      clearTimeout(timer);
      resolve(r.result);
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(r.error);
    };
  });
}
export async function listBlueprints(): Promise<SavedBlueprint[]> {
  const db = await open();
  const rows = (await request(
    db.transaction(STORE, "readonly").objectStore(STORE).getAll(),
  )) as SavedBlueprint[];
  if (rows.length > MAX) throw new Error("Blueprint library exceeds its revision limit.");
  const checked = await Promise.all(
    rows.map(async (row) => {
      const b = parseBlueprint(row.blueprint);
      if (row.key !== `${b.id}:${b.revision}` || row.digest !== (await blueprintDigest(b)))
        throw new Error(
          "A saved blueprint failed its integrity check. No actions are enabled from this library.",
        );
      return { ...row, blueprint: b };
    }),
  );
  return checked.sort(
    (a, b) => b.savedAt - a.savedAt || b.blueprint.revision - a.blueprint.revision,
  );
}
/** Append-only revision with compare-and-swap; an imported configuration saves as a new local identity. */
export async function saveBlueprint(
  draft: unknown,
  parent?: SavedBlueprint,
): Promise<SavedBlueprint> {
  const b = parseBlueprint(draft);
  const blueprint = parseBlueprint({
    ...b,
    id: parent?.blueprint.id ?? `bp-${crypto.randomUUID()}`,
    revision: parent ? parent.blueprint.revision + 1 : 1,
    createdAt: Date.now(),
  });
  const row: SavedBlueprint = {
    key: `${blueprint.id}:${blueprint.revision}`,
    blueprint,
    digest: await blueprintDigest(blueprint),
    savedAt: Date.now(),
  };
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"),
      s = tx.objectStore(STORE);
    let reason = "Could not save the blueprint.";
    const timer = setTimeout(() => {
      reason = "Blueprint save timed out.";
      try {
        tx.abort();
      } catch {
        /* ended */
      }
      reject(new Error(reason));
    }, 3000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      clearTimeout(timer);
      reject(new Error(reason));
    };
    const count = s.count();
    count.onsuccess = () => {
      if (count.result >= MAX) {
        reason =
          "The device library contains 200 immutable revisions. Export them before starting a new device library.";
        tx.abort();
        return;
      }
      if (!parent) {
        s.add(row);
        return;
      }
      const read = s.index("blueprintId").getAll(parent.blueprint.id);
      read.onsuccess = () => {
        const latest = (read.result as SavedBlueprint[]).sort(
          (a, c) => c.blueprint.revision - a.blueprint.revision,
        )[0];
        if (!latest || latest.key !== parent.key || latest.digest !== parent.digest) {
          reason =
            "This blueprint changed in another tab. Select its latest revision before saving.";
          tx.abort();
          return;
        }
        s.add(row);
      };
    };
  });
  wire();
  notify();
  channel?.postMessage({ changed: true });
  return row;
}

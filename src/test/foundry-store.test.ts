import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftBlueprint } from "@/lib/foundry";
const b = () =>
  draftBlueprint({
    address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    mintX: "So11111111111111111111111111111111111111112",
    mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    binStep: 10,
  });
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
});
describe("immutable blueprint device revisions", () => {
  it("preserves old revisions and rejects a concurrent stale-parent append", async () => {
    const store = await import("@/lib/foundry-store");
    const one = await store.saveBlueprint(b());
    const attempts = await Promise.allSettled([
      store.saveBlueprint({ ...one.blueprint, name: "First edit" }, one),
      store.saveBlueprint({ ...one.blueprint, name: "Concurrent edit" }, one),
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const refusal = attempts.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(refusal.reason.message).toMatch(/another tab/);
    const rows = await store.listBlueprints();
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.key === one.key)).toEqual(one);
    expect(rows.find((x) => x.blueprint.revision === 2)?.digest).not.toBe(one.digest);
  });
  it("makes imported identifiers and revision numbers a new local identity", async () => {
    const store = await import("@/lib/foundry-store");
    const first = await store.saveBlueprint({ ...b(), id: "external-blueprint", revision: 90 });
    const second = await store.saveBlueprint(first.blueprint);
    expect(first.blueprint.id).not.toBe("external-blueprint");
    expect(first.blueprint.revision).toBe(1);
    expect(second.blueprint.id).not.toBe(first.blueprint.id);
    expect(second.blueprint.revision).toBe(1);
  });
  it("fails visibly rather than silently pretending to persist without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = await import("@/lib/foundry-store");
    await expect(store.saveBlueprint(b())).rejects.toThrow(/unavailable/);
  });
  it("refuses a library row whose blueprint does not match its digest", async () => {
    const store = await import("@/lib/foundry-store");
    const one = await store.saveBlueprint(b());
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("studio-loco-foundry", 1);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction("revisions", "readwrite");
        tx.objectStore("revisions").put({
          ...one,
          blueprint: { ...one.blueprint, name: "tampered" },
        });
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    });
    await expect(store.listBlueprints()).rejects.toThrow(/integrity/);
  });
});

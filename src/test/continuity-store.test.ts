import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { migrateJourney, chapterId, Chapter, applyChapter } from "@/lib/continuity";
import { journey, identity } from "./journey-fixtures";
function linked() {
  const j = journey();
  return {
    ...j,
    links: [
      {
        recordId: "tx-original",
        signature: "4".repeat(88),
        slot: 100,
        blueprintId: "bp-store-test",
        revision: 1,
        digest: "a".repeat(64),
        name: "Persistent origin",
        action: "liquidity" as const,
        feeLamports: "5000",
      },
    ],
  };
}
async function store() {
  return import("@/lib/continuity-store");
}
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
});
describe("Durable Continuity storage", () => {
  it("preserves the origin and refuses stale cross-tab writers", async () => {
    const api = await store(),
      s = await api.saveStrategy(migrateJourney(linked())!);
    await api.saveStrategy({ ...s, label: "New display name" }, s);
    await expect(api.saveStrategy({ ...s, label: "Stale edit" }, s)).rejects.toThrow("another tab");
    expect((await api.listStrategies())[0]!.origin).toEqual(s.origin);
  });
  it("refuses changing retained chapter contents even if the ID remains the same", async () => {
    const api = await store(),
      s = await api.saveStrategy(migrateJourney(linked())!);
    await expect(
      api.saveStrategy(
        { ...s, chapters: s.chapters.map((c) => ({ ...c, feeLamports: "999999" })) },
        s,
      ),
    ).rejects.toThrow("immutable");
    expect((await api.listStrategies())[0]!.chapters[0]!.feeLamports).toBe("5000");
  });
  it("compares immutable ancestry against the actual stored row", async () => {
    const api = await store(),
      s = await api.saveStrategy(migrateJourney(linked())!);
    const forgedParent = {
      ...s,
      accounts: s.accounts.map((a) => ({ ...a, joinedAt: a.joinedAt + 1 })),
    };
    await expect(api.saveStrategy(forgedParent, forgedParent)).rejects.toThrow("ancestry");
  });
  it("non-destructively migrates v1 and records revision conflicts", async () => {
    const api = await store(),
      original = linked();
    expect(await api.migrateJourneys([original])).toBe(1);
    expect(await api.migrateJourneys([original])).toBe(0);
    const next = {
      ...original,
      links: [
        ...original.links,
        { ...original.links[0]!, signature: "5".repeat(88), revision: 2, digest: "b".repeat(64) },
      ],
    };
    await api.migrateJourneys([next]);
    const s = (await api.listStrategies())[0]!;
    expect(s.origin!.revision).toBe(1);
    expect(s.conflicts[0]!.revision).toBe(2);
    expect(original.links).toHaveLength(1);
  });
  it("does not resurrect removed origins unless recovery is explicit", async () => {
    const api = await store();
    await api.migrateJourneys([linked()]);
    await api.removeStrategy((await api.listStrategies())[0]!);
    expect(await api.migrateJourneys([linked()])).toBe(0);
    expect(await api.listStrategies()).toEqual([]);
    expect(await api.restoreOrigins([linked()])).toBe(1);
  });
  it("upgrades a v1 continuity store without losing existing rows", async () => {
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("studio-loco-continuity", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("strategies", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
    });
    const s = migrateJourney(linked())!;
    await new Promise<void>((resolve) => {
      const t = old.transaction("strategies", "readwrite");
      t.objectStore("strategies").put(s);
      t.oncomplete = () => resolve();
    });
    old.close();
    expect((await (await store()).listStrategies())[0]!.id).toBe(s.id);
  });
  it("rejects closure rollback and stale removal", async () => {
    const api = await store(),
      s = await api.saveStrategy(migrateJourney(linked())!);
    const signature = "5".repeat(88);
    const ch = Chapter.parse({
      id: chapterId(signature, 0, identity.account),
      action: "close",
      account: identity.account,
      pool: identity.pool,
      signature,
      step: 0,
      slot: 200,
      verifiedAt: 12000,
      instructions: ["close_position2"],
      feeLamports: "5000",
      recordId: "tx-closure",
      planId: null,
      reviewId: null,
      alertId: null,
      before: null,
      after: null,
      accountAfter: "closed",
    });
    const next = await api.saveStrategy(
      applyChapter(s, ch, { owner: identity.owner, kind: "position" }),
      s,
    );
    await expect(
      api.saveStrategy(
        { ...next, accounts: next.accounts.map((a) => ({ ...a, closed: null })) },
        next,
      ),
    ).rejects.toThrow("closures");
    await expect(api.removeStrategy(s)).rejects.toThrow("another tab");
  });
  it("fails explicitly when durable device storage is absent", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect((await store()).listStrategies()).rejects.toThrow("Persistent device storage");
  });
});

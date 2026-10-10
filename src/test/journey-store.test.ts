import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { appendSnapshot } from "@/lib/journey";
import { listJourneys, removeJourney, saveJourney } from "@/lib/journey-store";
import { journey, position } from "./journey-fixtures";
beforeEach(async () => {
  for (const j of await listJourneys()) await removeJourney(j);
});
describe("Journey durable device evidence", () => {
  it("persists verified snapshots and reloads an exact watch-only identity", async () => {
    const j = await saveJourney(appendSnapshot(journey(), position));
    expect((await listJourneys())[0]).toEqual(j);
    expect(j.links).toEqual([]);
  });
  it("refuses an accidental overwrite of an existing account", async () => {
    await saveJourney(journey());
    await expect(saveJourney(journey())).rejects.toThrow("another tab");
  });
  it("only one concurrent writer can append to the same revision", async () => {
    const parent = await saveJourney(journey());
    const result = await Promise.allSettled([
      saveJourney(appendSnapshot(parent, position), parent),
      saveJourney({ ...parent, label: "concurrent" }, parent),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listJourneys())[0]!.revision).toBe(2);
  });
  it("refuses changing owner/pool under an existing identity", async () => {
    const j = await saveJourney(journey());
    await expect(saveJourney({ ...j, owner: position.mintX }, j)).rejects.toThrow();
  });
  it("keeps retained snapshots on a read failure", async () => {
    const j = await saveJourney(appendSnapshot(journey(), position));
    const saved = await saveJourney({ ...j, lastError: "Account missing", lastAttempt: 12000 }, j);
    expect(saved.snapshots[0]).toEqual(position);
    expect(saved.lastError).toBe("Account missing");
  });
  it("refuses a stale removal and preserves the newer observation", async () => {
    const parent = await saveJourney(journey());
    await saveJourney(appendSnapshot(parent, position), parent);
    await expect(removeJourney(parent)).rejects.toThrow("another tab");
    expect(await listJourneys()).toHaveLength(1);
  });
  it("validates persisted identities and rejects backwards evidence before writing", async () => {
    const j = appendSnapshot(journey(), position);
    await expect(saveJourney({ ...j, id: "wrong-id" })).rejects.toThrow("identity");
    await expect(
      saveJourney({ ...j, snapshots: [position, { ...position, observedAt: 12000, slot: 99 }] }),
    ).rejects.toThrow("sequence");
  });
});

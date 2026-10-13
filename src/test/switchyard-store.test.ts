import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createShadowExperiment,
  appendShadowObservation,
  exportSwitchyard,
  parseSwitchyardImport,
} from "@/lib/switchyard";
import { identity, position } from "./journey-fixtures";
let clock = 1_700_000_000_000;
beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
const create = () =>
  createShadowExperiment({
    identity,
    snapshot: { ...position, observedAt: clock - 1 },
    label: "Durable comparison",
    now: clock,
    policy: {
      version: 1,
      edgeBins: 3,
      cooldownMs: 300_000,
      widenByBins: 20,
      maxWidthBins: 69,
      assumedFeeLamports: null,
    },
  });
describe("Switchyard durable storage invariants", () => {
  it("persists sealed policy and refuses stale concurrent writes", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = await s.saveShadowExperiment(create());
    clock += 2000;
    const candidate = appendShadowObservation(
      e,
      { ...position, activeId: 8, observedAt: clock, slot: 102, checkedSlot: 103 },
      clock,
    );
    const updated = await s.saveShadowExperiment(candidate, e);
    expect(updated.revision).toBe(2);
    await expect(s.saveShadowExperiment(candidate, e)).rejects.toThrow(/another tab/);
    expect((await s.getShadowExperiment(e.id))!.samples).toHaveLength(1);
  });
  it("compares source and policy with the stored row even if the supplied parent is altered", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = await s.saveShadowExperiment(create());
    const altered = { ...e, policy: { ...e.policy, cooldownMs: 60_000 } };
    await expect(s.saveShadowExperiment(altered, altered)).rejects.toThrow(/immutable/);
    expect((await s.getShadowExperiment(e.id))!.policy.cooldownMs).toBe(300_000);
  });
  it("an atomic pause rejects an in-flight observation and retains the latest history", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = await s.saveShadowExperiment(create());
    clock += 2000;
    const candidate = appendShadowObservation(
      e,
      { ...position, activeId: 8, observedAt: clock, slot: 102, checkedSlot: 103 },
      clock,
    );
    await s.setShadowStatus(e.id, "paused");
    await expect(s.saveShadowExperiment(candidate, e)).rejects.toThrow(/another tab/);
    const saved = (await s.getShadowExperiment(e.id))!;
    expect(saved.status).toBe("paused");
    expect(saved.samples).toHaveLength(0);
    const resumed = await s.setShadowStatus(e.id, "running");
    expect(resumed!.pendingReset).toBe("paused");
  });
  it("keeps old read failures from marking a newer accepted sample unavailable", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = await s.saveShadowExperiment(create());
    clock += 2000;
    const next = await s.saveShadowExperiment(
      appendShadowObservation(
        e,
        {
          ...position,
          activeId: 8,
          observedAt: clock,
          slot: 102,
          checkedSlot: 103,
        },
        clock,
      ),
      e,
    );
    await s.noteShadowReadError(e.id, 0, "Older read failed");
    expect((await s.getShadowExperiment(e.id))!.lastError).toBeNull();
    expect(next.samples).toHaveLength(1);
  });
  it("does not resurrect a removed experiment from a stale observer or status operation", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = await s.saveShadowExperiment(create());
    await s.removeShadowExperiment(e);
    await expect(s.saveShadowExperiment(e, e)).rejects.toThrow(/removed/);
    expect(await s.setShadowStatus(e.id, "running")).toBeNull();
    expect(await s.getShadowExperiment(e.id)).toBeNull();
  });
  it("never resumes imported evidence or inserts backfilled observations as a device experiment", async () => {
    const s = await import("@/lib/switchyard-store");
    const e = create();
    const [copy] = parseSwitchyardImport(JSON.stringify(exportSwitchyard([e])));
    await s.saveShadowExperiment(copy!);
    await expect(s.setShadowStatus(copy!.id, "running")).rejects.toThrow(/Imported/);
    clock += 2000;
    const backfill = appendShadowObservation(
      e,
      { ...position, activeId: 8, observedAt: clock, slot: 102, checkedSlot: 103 },
      clock,
    );
    await expect(s.saveShadowExperiment(backfill)).rejects.toThrow(/backfilled/);
  });
  it("requires the original gap cause and never rewrites retained sample truth", async () => {
    const s = await import("@/lib/switchyard-store");
    let e = await s.saveShadowExperiment(create());
    await s.noteShadowReadError(e.id, 0, "Unavailable");
    e = (await s.getShadowExperiment(e.id))!;
    clock += 2000;
    const next = appendShadowObservation(
      e,
      { ...position, activeId: 8, observedAt: clock, slot: 102, checkedSlot: 103 },
      clock,
    );
    const dishonest = structuredClone(next);
    dishonest.samples[0]!.gapReason = "paused";
    await expect(s.saveShadowExperiment(dishonest, e)).rejects.toThrow(/original cause/);
    await s.saveShadowExperiment(next, e);
  });
  it("reports missing persistent storage instead of silently pretending to save", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    const s = await import("@/lib/switchyard-store");
    await expect(s.saveShadowExperiment(create())).rejects.toThrow(/Persistent/);
  });
});

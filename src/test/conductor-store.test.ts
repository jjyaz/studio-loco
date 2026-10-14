import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createConductorMission,
  sealMissionPolicy,
  exportMission,
  analyzeMissionExport,
} from "@/lib/conductor";
import { at, missionPolicy, missionSnapshot } from "./conductor-fixtures";
let clock = at + 2000;
beforeEach(() => {
  vi.resetModules();
  clock = at + 2000;
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
const store = () => import("@/lib/conductor-store");
async function setup() {
  const api = await store();
  const m = await api.saveNewMission(
    createConductorMission(
      "Persistent mission",
      await sealMissionPolicy(missionPolicy(), 1, at),
      missionSnapshot(),
    ),
  );
  return { api, m };
}
describe("Conductor durable journal", () => {
  it("saves a fresh baseline and refuses duplicate or backfilled missions", async () => {
    const { api, m } = await setup();
    expect((await api.listMissions())[0]).toEqual(m);
    await expect(api.saveNewMission(m)).rejects.toThrow();
    await expect(
      api.saveNewMission({ ...m, id: "mission-forged", omittedSamples: 1 }),
    ).rejects.toThrow();
    clock += 130000;
    const candidate = createConductorMission(
      "Stale",
      await sealMissionPolicy(missionPolicy(clock), 1, at),
      missionSnapshot(),
    );
    await expect(api.saveNewMission(candidate)).rejects.toThrow(/fresh baseline/);
  });
  it("checks actual stored CAS revision, including pause during an in-flight read", async () => {
    const { api, m } = await setup();
    clock += 2000;
    const paused = await api.setMissionStatus(m.id, m.revision, "paused");
    await expect(
      api.appendMissionObservation(m.id, m.revision, missionSnapshot(clock)),
    ).rejects.toThrow(/another tab/);
    expect((await api.getMission(m.id))!.revision).toBe(paused!.revision);
    expect((await api.getMission(m.id))!.samples).toHaveLength(1);
  });
  it("preserves immutable policies and observations while sealing a new revision", async () => {
    const { api, m } = await setup();
    clock += 2000;
    const p = await sealMissionPolicy({ ...m.policies[0]!.policy, maxImpactBps: 70 }, 2, clock);
    const revised = (await api.appendMissionPolicy(m.id, m.revision, p))!;
    expect(revised.samples).toEqual(m.samples);
    expect(revised.policies[0]).toEqual(m.policies[0]);
    expect(revised.status).toBe("paused");
    clock += 2000;
    const observed = (await api.appendMissionObservation(
      m.id,
      revised.revision,
      missionSnapshot(clock),
    ))!;
    expect(observed.samples[1]!.policyRevision).toBe(2);
    expect((await analyzeMissionExport(exportMission(observed))).policyRevisions).toBe(2);
  });
  it("rejects changed scope, forged policy digests and reads preceding a new seal", async () => {
    const { api, m } = await setup();
    clock += 2000;
    const different = await sealMissionPolicy(
      {
        ...missionPolicy(),
        scope: { ...missionPolicy().scope, owner: missionPolicy().scope.pool },
      },
      2,
      clock,
    );
    await expect(api.appendMissionPolicy(m.id, m.revision, different)).rejects.toThrow(/scope/);
    const p = await sealMissionPolicy(missionPolicy(), 2, clock);
    await expect(
      api.appendMissionPolicy(m.id, m.revision, { ...p, digest: "0".repeat(64) }),
    ).rejects.toThrow(/digest/);
    const revised = (await api.appendMissionPolicy(m.id, m.revision, p))!;
    await expect(
      api.appendMissionObservation(m.id, revised.revision, missionSnapshot()),
    ).rejects.toThrow(/stale/);
  });
  it("rejects backwards slots, stale clocks, wrong scope and expired policies", async () => {
    const { api, m } = await setup();
    clock += 2000;
    await expect(
      api.appendMissionObservation(m.id, m.revision, { ...missionSnapshot(clock), slot: 99 }),
    ).rejects.toThrow(/backwards/);
    await expect(
      api.appendMissionObservation(m.id, m.revision, {
        ...missionSnapshot(clock),
        scope: { ...missionPolicy().scope, pool: missionPolicy().scope.owner },
      }),
    ).rejects.toThrow(/scope/);
    clock += 130000;
    await expect(api.appendMissionObservation(m.id, m.revision, missionSnapshot())).rejects.toThrow(
      /stale/,
    );
    clock = missionPolicy().expiresAt;
    await expect(api.setMissionStatus(m.id, m.revision, "monitoring")).rejects.toThrow(/expired/);
  });
  it("retains 120 immutable observations, discloses omissions and prunes only old acknowledgements", async () => {
    const { api, m } = await setup();
    let current = m;
    current = (await api.acknowledgeMissionFact(m.id, m.samples[0]!.recordId))!;
    for (let i = 0; i < 121; i++) {
      clock += 2000;
      current = (await api.appendMissionObservation(m.id, current.revision, {
        ...missionSnapshot(clock),
        slot: 101 + i,
        funds: { ...missionSnapshot(clock).funds!, slot: 102 + i },
      }))!;
    }
    expect(current.samples).toHaveLength(120);
    expect(current.omittedSamples).toBe(2);
    expect(current.samples[0]!.seq).toBe(3);
    expect(current.samples.at(-1)!.seq).toBe(122);
    expect(current.recorderLinks).toHaveLength(0);
    expect((await analyzeMissionExport(exportMission(current))).omittedObservations).toBe(2);
  });
  it("does not resurrect deleted missions or acknowledge nonexistent facts", async () => {
    const { api, m } = await setup();
    const unchanged = await api.acknowledgeMissionFact(m.id, "fact-not-retained");
    expect(unchanged!.revision).toBe(m.revision);
    await api.removeMission(m.id, m.revision);
    clock += 2000;
    await expect(
      api.appendMissionObservation(m.id, m.revision, missionSnapshot(clock)),
    ).rejects.toThrow(/removed/);
    expect(await api.listMissions()).toEqual([]);
  });
  it("fails honestly if durable device storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect((await store()).listMissions()).rejects.toThrow(/unavailable/);
  });
});

import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConductorMission, sealMissionPolicy } from "@/lib/conductor";
import { JobControl } from "@/lib/job-control";
import { at, missionPolicy, missionSnapshot } from "./conductor-fixtures";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  record: vi.fn(),
  getRecord: vi.fn(),
  temporary: false,
}));
vi.mock("@/lib/conductor-chain", () => ({
  readConductorSnapshot: (...args: unknown[]) => mocks.read(...args),
}));
vi.mock("@/lib/recorder-store", () => ({
  recordFact: (...args: unknown[]) => mocks.record(...args),
  getRecord: (...args: unknown[]) => mocks.getRecord(...args),
  usingMemoryFallback: () => mocks.temporary,
}));
let clock = at + 2000;
beforeEach(() => {
  vi.resetModules();
  clock = at + 2000;
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  mocks.temporary = false;
  mocks.read.mockReset();
  mocks.record.mockReset().mockImplementation(async (o) => o.id);
  mocks.getRecord.mockReset().mockResolvedValue(null);
});
async function setup() {
  const store = await import("@/lib/conductor-store");
  const m = await store.saveNewMission(
    createConductorMission(
      "Capture test",
      await sealMissionPolicy(missionPolicy(), 1, at),
      missionSnapshot(),
    ),
  );
  clock += 2000;
  mocks.read.mockResolvedValue(missionSnapshot(clock));
  const ctl = new JobControl(),
    job = ctl.begin()!;
  return { store, m, ctl, job, capture: await import("@/lib/conductor-capture") };
}
const connection = { sendTransaction: vi.fn(), sendRawTransaction: vi.fn() } as never;
describe("Conductor read-only capture and Recorder repair", () => {
  it("commits measurements durably BEFORE copying Recorder facts, and never sends", async () => {
    const { store, m, ctl, job, capture } = await setup();
    mocks.record.mockImplementation(async (o) => {
      expect((await store.getMission(m.id))!.samples).toHaveLength(2);
      return o.id;
    });
    const result = await capture.observeConductorMission(connection, m.id, job, "relay");
    ctl.end(job);
    expect(result.recorderError).toBeNull();
    expect(result.mission!.recorderLinks).toHaveLength(3);
    expect((connection as any).sendRawTransaction).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls[0]![1].minimumSlot).toBe(101);
  });
  it("retains measurements when Recorder fails and allows later repair", async () => {
    const { store, m, ctl, job, capture } = await setup();
    mocks.record.mockRejectedValue(new Error("Recorder quota"));
    const result = await capture.observeConductorMission(connection, m.id, job, "relay");
    expect(result.recorderError).toMatch(/quota/);
    expect((await store.getMission(m.id))!.samples).toHaveLength(2);
    expect((await store.getMission(m.id))!.recorderLinks).toHaveLength(0);
    mocks.record.mockResolvedValue("saved");
    await capture.repairConductorRecorder(m.id, job);
    ctl.end(job);
    expect((await store.getMission(m.id))!.recorderLinks).toHaveLength(3);
  });
  it("never overwrites conflicting Recorder facts or acknowledges temporary storage", async () => {
    const { store, m, ctl, job, capture } = await setup();
    mocks.getRecord.mockResolvedValue({ kind: "wallet-action", context: {} });
    await expect(capture.repairConductorRecorder(m.id, job)).rejects.toThrow(/collision/);
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.getRecord.mockResolvedValue(null);
    mocks.temporary = true;
    await expect(capture.repairConductorRecorder(m.id, job)).rejects.toThrow(/temporary/);
    ctl.end(job);
    expect((await store.getMission(m.id))!.recorderLinks).toHaveLength(0);
  });
  it("discards an in-flight observation when another tab pauses or revises the mission", async () => {
    const { store, m, ctl, job, capture } = await setup();
    mocks.read.mockImplementation(async () => {
      await store.setMissionStatus(m.id, m.revision, "paused");
      return missionSnapshot(clock);
    });
    await expect(capture.observeConductorMission(connection, m.id, job, "relay")).rejects.toThrow(
      /another tab/,
    );
    ctl.end(job);
    expect((await store.getMission(m.id))!.samples).toHaveLength(1);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("records failed reads as gaps without inventing a replacement snapshot", async () => {
    const { store, m, ctl, job, capture } = await setup();
    mocks.read.mockRejectedValue(new Error("RPC unavailable"));
    await expect(capture.observeConductorMission(connection, m.id, job, "relay")).rejects.toThrow(
      /unavailable/,
    );
    ctl.end(job);
    const saved = (await store.getMission(m.id))!;
    expect(saved.samples).toHaveLength(1);
    expect(saved.lastError).toBe("RPC unavailable");
    expect(saved.gaps[0]!.reason).toBe("RPC unavailable");
  });
});

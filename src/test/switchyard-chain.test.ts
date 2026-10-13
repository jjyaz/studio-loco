import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { identity, position, journey } from "./journey-fixtures";
import { createShadowExperiment, retainedDecisions } from "@/lib/switchyard";
import { JobControl } from "@/lib/job-control";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  listJourneys: vi.fn(),
  saveJourney: vi.fn(),
  record: vi.fn(),
  getRecord: vi.fn(),
  temporary: false,
}));
vi.mock("@/lib/journey-chain", () => ({
  readJourneySnapshot: (...a: unknown[]) => mocks.read(...a),
}));
vi.mock("@/lib/journey-store", () => ({
  listJourneys: () => mocks.listJourneys(),
  saveJourney: (...a: unknown[]) => mocks.saveJourney(...a),
}));
vi.mock("@/lib/recorder-store", () => ({
  recordFact: (...a: unknown[]) => mocks.record(...a),
  getRecord: (...a: unknown[]) => mocks.getRecord(...a),
  usingMemoryFallback: () => mocks.temporary,
}));
let clock = 1_700_000_000_000;
beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  mocks.temporary = false;
  mocks.read.mockReset();
  mocks.listJourneys
    .mockReset()
    .mockResolvedValue([{ ...journey(), snapshots: [{ ...position, observedAt: clock - 1 }] }]);
  mocks.saveJourney.mockReset().mockResolvedValue({});
  mocks.record.mockReset().mockImplementation(async (o) => o.id);
  mocks.getRecord.mockReset().mockResolvedValue(null);
});
async function setup() {
  const s = await import("@/lib/switchyard-store");
  const e = await s.saveShadowExperiment(
    createShadowExperiment({
      identity,
      snapshot: { ...position, observedAt: clock - 1 },
      label: "Read-only test",
      now: clock,
      policy: {
        version: 1,
        edgeBins: 3,
        cooldownMs: 300_000,
        widenByBins: 20,
        maxWidthBins: 69,
        assumedFeeLamports: null,
      },
    }),
  );
  clock += 2000;
  mocks.read.mockResolvedValue({
    ...position,
    observedAt: clock,
    activeId: 8,
    slot: 102,
    checkedSlot: 103,
  });
  return { s, e, chain: await import("@/lib/switchyard-chain") };
}
const connection = { sendRawTransaction: vi.fn(), signTransaction: vi.fn() } as never;
describe("Switchyard read-only capture boundaries", () => {
  it("commits an observation before Recorder copying, without signing or broadcasting", async () => {
    const { s, e, chain } = await setup();
    mocks.record.mockImplementation(async (o) => {
      const durable = await s.getShadowExperiment(e.id);
      expect(durable!.samples).toHaveLength(1);
      expect(retainedDecisions(durable!).some((d) => d.recordId === o.id)).toBe(true);
      return o.id;
    });
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const result = await chain.observeShadowExperiment({
      connection,
      id: e.id,
      source: "relay",
      job,
    });
    ctl.end(job);
    expect(result!.recorderLinks).toHaveLength(2);
    expect(mocks.read.mock.calls[0]![5]).toBe(e.seed.checkedSlot);
    expect((connection as any).sendRawTransaction).not.toHaveBeenCalled();
    expect((connection as any).signTransaction).not.toHaveBeenCalled();
  });
  it("keeps verified durable decisions when Recorder persistence fails, for later repair", async () => {
    const { s, e, chain } = await setup();
    mocks.record.mockRejectedValue(new Error("Recorder quota"));
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const result = await chain.observeShadowExperiment({
      connection,
      id: e.id,
      source: "relay",
      job,
    });
    ctl.end(job);
    expect(result!.samples).toHaveLength(1);
    expect(result!.lastError).toBeNull();
    expect(result!.recorderLinks).toHaveLength(0);
    expect(result!.recorderError).toMatch(/quota/);
    mocks.record.mockImplementation(async (o) => o.id);
    const repair = ctl.begin()!;
    await chain.repairShadowRecorder(e.id, repair);
    ctl.end(repair);
    expect((await s.getShadowExperiment(e.id))!.recorderLinks).toHaveLength(2);
  });
  it("never acknowledges temporary Recorder data as durable or overwrites conflicting facts", async () => {
    const { s, e, chain } = await setup();
    mocks.temporary = true;
    const ctl = new JobControl(),
      job = ctl.begin()!;
    await chain.observeShadowExperiment({ connection, id: e.id, source: "relay", job });
    ctl.end(job);
    expect((await s.getShadowExperiment(e.id))!.recorderLinks).toHaveLength(0);
    mocks.temporary = false;
    mocks.getRecord.mockResolvedValue({ provenance: "import", kind: "proposal" });
    const repair = ctl.begin()!;
    const priorCalls = mocks.record.mock.calls.length;
    await expect(chain.repairShadowRecorder(e.id, repair)).rejects.toThrow(/conflict/);
    ctl.end(repair);
    expect(mocks.record).toHaveBeenCalledTimes(priorCalls);
  });
  it("drops an observation if a different tab pauses the experiment during its read", async () => {
    const { s, e, chain } = await setup();
    let finish!: (v: unknown) => void;
    mocks.read.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const work = chain.observeShadowExperiment({ connection, id: e.id, source: "relay", job });
    const rejection = expect(work).rejects.toThrow(/another tab/);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalled());
    await s.setShadowStatus(e.id, "paused");
    finish({ ...position, observedAt: clock, activeId: 8, slot: 102, checkedSlot: 103 });
    await rejection;
    ctl.end(job);
    expect((await s.getShadowExperiment(e.id))!.samples).toHaveLength(0);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("retains an explicit failed read and refuses a removed source without falling back", async () => {
    const { s, e, chain } = await setup();
    mocks.listJourneys.mockResolvedValue([]);
    const ctl = new JobControl(),
      job = ctl.begin()!;
    await expect(
      chain.observeShadowExperiment({ connection, id: e.id, source: "relay", job }),
    ).rejects.toThrow(/no longer tracked/);
    ctl.end(job);
    const saved = (await s.getShadowExperiment(e.id))!;
    expect(saved.samples).toHaveLength(0);
    expect(saved.pendingReset).toBe("read-error");
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

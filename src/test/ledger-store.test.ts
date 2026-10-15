import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createConductorMission, sealMissionPolicy } from "@/lib/conductor";
import type { ExecutionBudget, Operation } from "../../packages/sdk/src/ledger";
import { at, missionPolicy, missionSnapshot, missionScope } from "./conductor-fixtures";

let clock = at + 2000;
beforeEach(() => {
  vi.resetModules();
  clock = at + 2000;
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
const D = "a".repeat(64);
async function setup() {
  const store = await import("@/lib/conductor-store");
  const ledger = await import("@/lib/ledger-store");
  const policy = await sealMissionPolicy(missionPolicy(), 1, at);
  const m = await store.saveNewMission(createConductorMission("Ledger", policy, missionSnapshot()));
  const scope = { missionId: m.id, owner: missionScope.owner, cluster: "mainnet-beta" as const, pool: missionScope.pool, mintX: missionScope.mintX, mintY: missionScope.mintY };
  const budget = (revision: number, x = "100"): ExecutionBudget => ({
    v: 1, kind: "cumulative-execution-budget", scope, revision, policyDigest: policy.digest,
    totalXRaw: x, totalYRaw: "100", totalLamports: "100000", allowedActions: ["rebalance"], expiresAt: clock + 86_400_000,
  });
  let n = 0;
  const op = (x: string, rev = 1): Operation => ({
    id: `op-test-${String(++n).padStart(4, "0")}`, scope, budgetRevision: rev, policyDigest: policy.digest, action: "rebalance",
    state: "proposed", reserved: { xRaw: x, yRaw: "0", lamports: "5000" }, consumed: null, messageHash: null,
    signature: null, blockhash: null, lastValidBlockHeight: null, evidence: null, history: [{ state: "proposed", at: clock }],
  });
  return { store, ledger, m, budget, op };
}
async function reserve(ledger: typeof import("@/lib/ledger-store"), o: Operation) {
  await ledger.proposeOperation(o);
  await ledger.transitionOperation(o.id, 1, "reviewed");
  return ledger.transitionOperation(o.id, 2, "reserved");
}
const signEv = { signature: "sig", blockhash: "bh", messageHash: D };

describe("durable Conductor ledger", () => {
  it("refuses a budget not bound to the latest policy and stale budget revisions", async () => {
    const { ledger, budget } = await setup();
    await expect(ledger.sealBudget({ ...budget(1), policyDigest: D }, null)).rejects.toThrow(/latest sealed policy/);
    await ledger.sealBudget(budget(1), null);
    await expect(ledger.sealBudget(budget(2), null)).rejects.toThrow(/another tab/);
    await expect(ledger.sealBudget(budget(3), 1)).rejects.toThrow(/another tab/);
  });
  it("simultaneous reservations from two tabs cannot exceed the budget", async () => {
    const { ledger, budget, op } = await setup();
    await ledger.sealBudget(budget(1), null);
    const a = op("60");
    await ledger.proposeOperation(a);
    await ledger.transitionOperation(a.id, 1, "reviewed");
    // Second proposal blocked while the first is active (duplicate active operation).
    await expect(ledger.proposeOperation(op("60"))).rejects.toThrow(/still active/);
    const results = await Promise.allSettled([
      ledger.transitionOperation(a.id, 2, "reserved"),
      ledger.transitionOperation(a.id, 2, "reserved"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { operations, budgets } = await ledger.listLedger(a.scope.missionId);
    expect(ledger.summarize(budgets, operations)!.reserved.xRaw).toBe("60");
  });
  it("refuses a reservation over the remaining budget and survives reload", async () => {
    const { ledger, budget, op } = await setup();
    await ledger.sealBudget(budget(1), null);
    const a = await reserve(ledger, op("60"));
    const signed = await ledger.transitionOperation(a.id, a.row, "signed", signEv);
    const unknown = await ledger.transitionOperation(a.id, (await ledger.transitionOperation(a.id, signed.row, "submitted")).row, "unknown");
    vi.resetModules();
    const reloaded = await import("@/lib/ledger-store");
    const l = await reloaded.listLedger(a.op.scope.missionId);
    expect(l.operations[0]!.op.state).toBe("unknown");
    expect(reloaded.summarize(l.budgets, l.operations)!.remaining.xRaw).toBe("40");
    await expect(reloaded.transitionOperation(a.id, unknown.row, "failed", {})).rejects.toThrow(/independently verified/);
    await expect(reloaded.transitionOperation(a.id, unknown.row - 1, "expired", { independentlyVerified: true })).rejects.toThrow(/another tab/);
  });
  it("new budget revisions keep consumed and charged failure costs; stale revision ops refused", async () => {
    const { ledger, budget, op } = await setup();
    await ledger.sealBudget(budget(1), null);
    const a = await reserve(ledger, op("50"));
    let r = await ledger.transitionOperation(a.id, a.row, "signed", signEv);
    r = await ledger.transitionOperation(a.id, r.row, "submitted");
    await ledger.transitionOperation(a.id, r.row, "confirmed", { consumed: { xRaw: "50", yRaw: "0", lamports: "5000" }, independentlyVerified: true });
    await expect(ledger.sealBudget(budget(2, "40"), 1)).rejects.toThrow(/smaller than already consumed/);
    await ledger.sealBudget(budget(2, "120"), 1);
    const stale = op("10", 1);
    await ledger.proposeOperation(stale);
    await ledger.transitionOperation(stale.id, 1, "reviewed");
    await expect(ledger.transitionOperation(stale.id, 2, "reserved")).rejects.toThrow(/stale-revision/);
    await ledger.transitionOperation(stale.id, 2, "rejected");
    const b = await reserve(ledger, op("30", 2));
    let s = await ledger.transitionOperation(b.id, b.row, "signed", signEv);
    s = await ledger.transitionOperation(b.id, s.row, "submitted");
    await ledger.transitionOperation(b.id, s.row, "failed", { consumed: { xRaw: "0", yRaw: "0", lamports: "5000" }, independentlyVerified: true });
    const l = await ledger.listLedger(b.op.scope.missionId);
    const sum = ledger.summarize(l.budgets, l.operations)!;
    expect(sum.consumed).toEqual({ xRaw: "50", yRaw: "0", lamports: "10000" });
    expect(sum.remaining.xRaw).toBe("70");
  });
  it("rejects a revision change between reservation and signing", async () => {
    const { ledger, budget, op } = await setup();
    await ledger.sealBudget(budget(1), null);
    const a = await reserve(ledger, op("10"));
    await ledger.sealBudget(budget(2), 1);
    await expect(ledger.transitionOperation(a.id, a.row, "signed", signEv)).rejects.toThrow(/stale-revision/);
    const ok = await ledger.transitionOperation(a.id, a.row, "rejected");
    expect(ok.op.state).toBe("rejected");
  });
  it("mission deletion is refused while obligations are unresolved", async () => {
    const { store, ledger, m, budget, op } = await setup();
    await ledger.sealBudget(budget(1), null);
    const a = await reserve(ledger, op("10"));
    const r = await ledger.transitionOperation(a.id, a.row, "signed", signEv);
    await ledger.transitionOperation(a.id, r.row, "submitted");
    await expect(store.removeMission(m.id, m.revision)).rejects.toThrow(/unresolved/);
    expect(await store.getMission(m.id)).toBeTruthy();
  });
  it("fails closed when storage is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const ledger = await import("@/lib/ledger-store");
    await expect(ledger.listLedger("mission-none00")).rejects.toThrow(/unavailable/);
  });
});

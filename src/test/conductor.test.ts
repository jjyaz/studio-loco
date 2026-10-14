import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MissionPolicy,
  MissionRaw,
  missionQuoteMetrics,
  evaluateMission,
  previewMissionAction,
  sealMissionPolicy,
  createConductorMission,
  exportMission,
  analyzeMissionExport,
} from "@/lib/conductor";
import { at, missionPolicy, missionSnapshot, quote, missionScope } from "./conductor-fixtures";
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const q64 = "18446744073709551616";
describe("Conductor exact quote semantics", () => {
  it("separates movement from input fees including the protocol portion", () => {
    expect(missionQuoteMetrics(quote(), q64)).toMatchObject({
      impactBps: 0,
      feeBps: 100,
      totalFeeRaw: "10000",
    });
    expect(missionQuoteMetrics({ ...quote(), outputRaw: "980100" }, q64)).toMatchObject({
      impactBps: 100,
    });
  });
  it("adds fees in the OUTPUT currency for token-Y fee mode in both directions", () => {
    const outputFee = { ...quote(), outputRaw: "990000", feeOnInput: false };
    expect(missionQuoteMetrics(outputFee, q64)).toMatchObject({ impactBps: 0, feeBps: 100 });
    expect(missionQuoteMetrics({ ...outputFee, direction: "y-to-x" }, q64)).toMatchObject({
      impactBps: 0,
    });
  });
  it("uses active-bin raw price and integer arithmetic beyond safe Number amounts", () => {
    const q = {
      ...quote(),
      inputRaw: "1000000000000000000",
      consumedRaw: "1000000000000000000",
      outputRaw: "2000000000000000000",
      lpFeeRaw: "0",
      protocolFeeRaw: "0",
    };
    expect(missionQuoteMetrics(q, String(2n * BigInt(q64)))?.impactBps).toBe(0);
    expect(
      missionQuoteMetrics(
        { ...q, direction: "y-to-x", outputRaw: "500000000000000000" },
        String(2n * BigInt(q64)),
      )?.impactBps,
    ).toBe(0);
  });
  it("rounds deviation conservatively and refuses partial or zero-output quotes", () => {
    expect(missionQuoteMetrics({ ...quote(), outputRaw: "989999" }, q64)?.impactBps).toBe(1);
    expect(missionQuoteMetrics({ ...quote(), consumedRaw: "999999" }, q64)).toBeNull();
    expect(missionQuoteMetrics({ ...quote(), outputRaw: "0" }, q64)).toBeNull();
  });
  it("validates u64, canonical amounts and strictly increasing bounded ladders", () => {
    for (const n of ["-1", "1e9", "01", "18446744073709551616"])
      expect(MissionRaw.safeParse(n).success).toBe(false);
    expect(MissionRaw.parse("18446744073709551615")).toBe("18446744073709551615");
    for (const probesX of [["1", "1"], ["2", "1"], ["1", "2", "3", "4"], ["0"]])
      expect(MissionPolicy.safeParse({ ...missionPolicy(), probesX }).success).toBe(false);
  });
});
describe("Mission Health is sampled and fails closed", () => {
  it("passes a complete fresh ladder within separate impact, fee and reserve limits", () => {
    const r = evaluateMission(missionPolicy(), missionSnapshot(), at + 2000);
    expect(r.state).toBe("met");
    expect(r.directions[0]!.largestPassingRaw).toBe("1000000");
    expect(r.interpretation).toMatch(/not maximum depth/);
  });
  it("keeps unavailable, missing and partial probes UNKNOWN rather than zero or passing", () => {
    const s = missionSnapshot();
    s.quotes[0] = {
      status: "unavailable",
      direction: "x-to-y",
      inputRaw: "1000000",
      reason: "Coverage limit",
    };
    expect(evaluateMission(missionPolicy(), s, at + 2000).state).toBe("unknown");
    expect(evaluateMission(missionPolicy(), { ...s, quotes: [] }, at + 2000).state).toBe("unknown");
    expect(
      evaluateMission(
        missionPolicy(),
        { ...s, quotes: [{ ...quote(), consumedRaw: "2" }, quote("y-to-x")] },
        at + 2000,
      ).directions[0]!.largestPassingRaw,
    ).toBeNull();
  });
  it("shows a known breach even when other evidence is missing", () => {
    const s = missionSnapshot();
    s.quotes[0] = { ...quote(), outputRaw: "900000" };
    s.funds = null;
    expect(evaluateMission(missionPolicy(), s, at + 2000).state).toBe("unmet");
  });
  it("requires fresh collection start, fresh balances, correct scope, active pool and unexpired policy", () => {
    const p = missionPolicy(),
      s = missionSnapshot();
    expect(evaluateMission(p, s, at + 130000).state).toBe("unknown");
    expect(evaluateMission(p, { ...s, startedAt: at - 130000 }, at + 2000).state).toBe("unknown");
    expect(
      evaluateMission(p, { ...s, scope: { ...s.scope, mintX: s.scope.owner } }, at + 2000).state,
    ).toBe("unknown");
    expect(evaluateMission(p, { ...s, funds: null }, at + 2000).state).toBe("unknown");
    expect(evaluateMission(p, { ...s, enabled: false }, at + 2000).state).toBe("unmet");
    expect(evaluateMission({ ...p, expiresAt: at + 1500 }, s, at + 2000).state).toBe("unmet");
  });
  it("never gives an LP credit for pool capacity and requires its separate inventory evidence", () => {
    const scope = { ...missionScope, position: missionScope.pool, journeyId: "position:test" };
    const r = evaluateMission(
      { ...missionPolicy(), scope },
      { ...missionSnapshot(), scope },
      at + 2000,
    );
    expect(r.state).toBe("unknown");
    expect(r.checks.find((c) => c.code === "position")?.state).toBe("unknown");
  });
});
describe("read-only policy feasibility", () => {
  const intent = () => ({
    scope: missionScope,
    action: "rebalance",
    spendXRaw: "1",
    spendYRaw: "0",
    networkFeeLamports: null,
    rentLamports: null,
    nativeSolSpendLamports: null,
    lastConfirmedActionAt: null,
    cooldownEvidenceComplete: false,
  });
  it("blocks caps, action families and expired policies without inventing missing native costs", () => {
    const p = missionPolicy(),
      s = missionSnapshot();
    expect(previewMissionAction(p, s, intent(), at + 2000).state).toBe("needs-fresh-evidence");
    expect(
      previewMissionAction(p, s, { ...intent(), spendXRaw: "10000001" }, at + 2000).state,
    ).toBe("blocked");
    expect(
      previewMissionAction({ ...p, allowedActions: ["claim"] }, s, intent(), at + 2000).blocked[0],
    ).toMatch(/not allowed/);
    expect(
      previewMissionAction({ ...p, expiresAt: at + 1500 }, s, intent(), at + 2000).blocked,
    ).toContain("Policy has expired.");
  });
  it("checks complete SOL outflow and cooldown but NEVER returns executable authority", () => {
    const p = missionPolicy(),
      s = missionSnapshot();
    const complete = {
      ...intent(),
      networkFeeLamports: "5000",
      rentLamports: "10000",
      nativeSolSpendLamports: "0",
      cooldownEvidenceComplete: true,
    };
    expect(previewMissionAction(p, s, complete, at + 2000)).toMatchObject({
      state: "fits-declared-limits",
      executable: false,
    });
    expect(
      previewMissionAction(p, s, { ...complete, nativeSolSpendLamports: "1000000000" }, at + 2000)
        .state,
    ).toBe("blocked");
    expect(
      previewMissionAction(p, s, { ...complete, lastConfirmedActionAt: at + 1000 }, at + 2000)
        .state,
    ).toBe("blocked");
  });
});
describe("portable mission evidence", () => {
  it("validates canonical digests and re-evaluates supplied history without authenticating it", async () => {
    const p = await sealMissionPolicy(missionPolicy(), 1, at);
    const m = createConductorMission("Test", p, missionSnapshot());
    const r = await analyzeMissionExport(exportMission(m));
    expect(r).toMatchObject({
      independentlyVerified: false,
      retainedObservations: 1,
      policyRevisions: 1,
    });
    expect(r.note).toMatch(/not authenticated/);
    const tampered = exportMission(m);
    tampered.mission.policies[0]!.policy.maxImpactBps++;
    await expect(analyzeMissionExport(tampered)).rejects.toThrow(/digest/);
  });
  it("rejects rewritten sequence, policy binding, scope, unsupported fields and oversized bundles", async () => {
    const m = createConductorMission(
      "Test",
      await sealMissionPolicy(missionPolicy(), 1, at),
      missionSnapshot(),
    );
    const a = exportMission(m);
    a.mission.samples[0]!.policyDigest = "f".repeat(64);
    await expect(analyzeMissionExport(a)).rejects.toThrow(/binding/);
    const b = exportMission(m);
    b.mission.samples[0]!.seq = 4;
    await expect(analyzeMissionExport(b)).rejects.toThrow(/history/);
    await expect(analyzeMissionExport({ ...exportMission(m), execute: true })).rejects.toThrow();
    await expect(analyzeMissionExport(" ".repeat(2000001))).rejects.toThrow(/2 MB/);
  });
});

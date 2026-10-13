import { describe, expect, it } from "vitest";
import {
  createShadowExperiment,
  appendShadowObservation,
  promotionRefusal,
  parseSwitchyardImport,
  exportSwitchyard,
  shadowScorecards,
  retainedDecisions,
  SwitchyardExperiment,
  analyzeSwitchyardExport,
  shadowTransition,
  type ShadowExperiment,
} from "@/lib/switchyard";
import { identity, position } from "./journey-fixtures";
const policy = {
  version: 1 as const,
  edgeBins: 3,
  cooldownMs: 300_000,
  widenByBins: 20,
  maxWidthBins: 69,
  assumedFeeLamports: "5000",
};
const create = () =>
  createShadowExperiment({
    identity,
    snapshot: position,
    label: "Prospective track",
    policy,
    now: 11_000,
  });
function append(e: ShadowExperiment, active: number, at: number) {
  const last = e.samples.at(-1) ?? e.seed;
  return appendShadowObservation(
    e,
    {
      ...position,
      activeId: active,
      observedAt: at,
      slot: last.checkedSlot + 1,
      checkedSlot: last.checkedSlot + 2,
    },
    at,
  );
}
describe("prospective Switchyard policy evidence", () => {
  it("starts at a fresh baseline without inventing earlier scorecard history", () => {
    const e = create();
    expect(e.samples).toHaveLength(0);
    expect(shadowScorecards(e).every((s) => s.coveragePct === null)).toBe(true);
    expect(() =>
      createShadowExperiment({
        identity,
        snapshot: position,
        label: "Stale",
        policy,
        now: position.observedAt + 150_001,
      }),
    ).toThrow(/Fresh/);
  });
  it("scores against the pre-decision range; future samples alone benefit from recentering", () => {
    const first = append(create(), 20, 20_000);
    const r = first.samples[0]!.tracks[1]!;
    expect(r.covered).toBe(false);
    expect(r.before).toEqual({ lower: -10, upper: 10 });
    expect(r.after).toEqual({ lower: 10, upper: 30 });
    const second = append(first, 20, 30_000);
    const cards = shadowScorecards(second);
    expect(cards.find((s) => s.track === "recenter")?.coveragePct).toBe(50);
    expect(cards.find((s) => s.track === "stay")?.coveragePct).toBe(0);
    expect(second.samples[1]!.tracks[1]!.decision).toBeNull();
  });
  it("keeps widening inclusive and blocks movement beyond the chosen width cap", () => {
    const first = append(create(), 8, 20_000);
    const w = first.samples[0]!.tracks[2]!;
    expect(w.after.lower).toBeLessThanOrEqual(-10);
    expect(w.after.upper).toBeGreaterThanOrEqual(10);
    expect(w.after.upper - w.after.lower + 1).toBe(41);
    const far = append(create(), 200, 20_000);
    expect(far.samples[0]!.tracks[2]!.reason).toBe("width-cap");
    expect(far.samples[0]!.tracks[2]!.decision).toBeNull();
  });
  it("respects cooldown and never charges a no-op centering decision", () => {
    const first = append(create(), 20, 20_000);
    const next = append(first, 50, 30_000);
    expect(next.samples[1]!.tracks[1]!.reason).toBe("cooldown");
    expect(next.samples[1]!.tracks[1]!.after).toEqual(first.samples[0]!.tracks[1]!.after);
    expect(
      shadowTransition("recenter", { lower: 0, upper: 0 }, 0, policy, 100_000, null, false).reason,
    ).toBe("already-centered");
  });
  it("suppresses post-gap decisions and retains missing intervals as unknown", () => {
    const gap = append(create(), 40, 180_001);
    expect(gap.samples[0]!.gapReason).toBe("missed-interval");
    expect(gap.samples[0]!.tracks[1]!.reason).toBe("gap");
    expect(retainedDecisions(gap)).toHaveLength(0);
    const later = append(gap, 40, 190_000);
    expect(later.samples[1]!.tracks[1]!.decision).not.toBeNull();
  });
  it("treats explicit pause and read-error resets as gaps even at a short interval", () => {
    for (const pendingReset of ["paused", "read-error"] as const) {
      const e = append({ ...create(), pendingReset }, 20, 20_000);
      expect(e.samples[0]!.gapReason).toBe(pendingReset);
      expect(retainedDecisions(e)).toHaveLength(0);
    }
  });
  it("rejects mint, clock and slot regression instead of reusing unverified data", () => {
    const e = append(create(), 8, 20_000);
    expect(() =>
      appendShadowObservation(
        e,
        { ...position, observedAt: 21_000, slot: 100, checkedSlot: 101 },
        21_000,
      ),
    ).toThrow(/advance/);
    expect(() =>
      appendShadowObservation(
        e,
        { ...position, mintX: position.mintY, observedAt: 21_000, slot: 104, checkedSlot: 105 },
        21_000,
      ),
    ).toThrow(/identity/);
  });
  it("rejects retroactively improved coverage, rewritten actions and unknown executable fields", () => {
    const original = append(create(), 20, 20_000);
    const improved = structuredClone(original);
    improved.samples[0]!.tracks[1]!.covered = true;
    expect(SwitchyardExperiment.safeParse(improved).success).toBe(false);
    const action = structuredClone(original);
    action.samples[0]!.tracks[1]!.decision!.target.upper++;
    expect(SwitchyardExperiment.safeParse(action).success).toBe(false);
    expect(SwitchyardExperiment.safeParse({ ...original, instructions: ["sign"] }).success).toBe(
      false,
    );
  });
  it("keeps fee budgets exact and explicitly unpriced without a supplied assumption", () => {
    const e = append(create(), 8, 20_000);
    const cards = shadowScorecards(e);
    expect(cards.find((c) => c.track === "recenter")!.assumedProposalFeesLamports).toBe("5000");
    expect(cards.find((c) => c.track === "actual")!.assumedProposalFeesLamports).toBeNull();
    const huge = {
      ...e,
      policy: { ...e.policy, assumedFeeLamports: "999999999999999999999999999999" },
    };
    expect(
      shadowScorecards(huge).find((c) => c.track === "recenter")!.assumedProposalFeesLamports,
    ).toBe("999999999999999999999999999999");
    expect(
      shadowScorecards({ ...e, policy: { ...e.policy, assumedFeeLamports: null } }).every(
        (c) => c.assumedProposalFeesLamports === null,
      ),
    ).toBe(true);
  });
  it("drops only the old prefix and scores the disclosed retained window", () => {
    let e = create();
    for (let i = 1; i <= 365; i++) e = append(e, i % 7, 11_000 + i * 1000);
    expect(e.samples).toHaveLength(360);
    expect(e.omittedSamples).toBe(5);
    expect(e.samples[0]!.seq).toBe(6);
    expect(shadowScorecards(e).every((s) => s.samples === 360)).toBe(true);
    expect(SwitchyardExperiment.safeParse(e).success).toBe(true);
  });
  it("isolates imports and cannot turn supplied history into live observations or reviews", () => {
    const e = append(create(), 8, 20_000);
    const [copy] = parseSwitchyardImport(JSON.stringify(exportSwitchyard([e], 21_000)), 22_000);
    expect(copy!.id).not.toBe(e.id);
    expect(copy!.suppliedId).toBe(e.id);
    expect(copy!.status).toBe("paused");
    expect(copy!.recorderLinks).toEqual([]);
    expect(() => append(copy!, 20, 23_000)).toThrow(/running device/);
    expect(promotionRefusal(copy!, retainedDecisions(copy!)[0]!, 23_000)).toMatch(/Imported/);
  });
  it("expires and supersedes promoted intents without replaying stored execution inputs", () => {
    const e = append(create(), 8, 20_000);
    const d = retainedDecisions(e)[0]!;
    expect(promotionRefusal(e, d, 21_000)).toBeNull();
    expect(promotionRefusal(e, { ...d, recordedAt: 21_000 }, 22_000)).toMatch(/differ/);
    expect(promotionRefusal(e, d, 140_001)).toMatch(/historical/);
    expect(promotionRefusal(append(e, 9, 30_000), d, 31_000)).toMatch(/newer/);
  });
  it("SDK analysis recomputes reported metrics while withholding chain and execution authentication", () => {
    const e = append(create(), 8, 20_000);
    const report = analyzeSwitchyardExport(exportSwitchyard([e], 21_000));
    expect(report.chainVerified).toBe(false);
    expect(report.executable).toBe(false);
    expect(report.model).toBe("range-policy-only");
    expect(report.experiments[0]!.hypotheticalDecisions).toBe(2);
    const duplicated = { ...exportSwitchyard([e], 21_000), experiments: [e, e] };
    expect(() => analyzeSwitchyardExport(duplicated)).toThrow(/Duplicate/);
    expect(() => parseSwitchyardImport("é".repeat(5_000_001))).toThrow(/10 MB/);
  });
});

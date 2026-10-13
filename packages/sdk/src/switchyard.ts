/** Prospective range-policy evidence. No token inventory model, chain access or execution. */
import { z } from "zod";

export const SWITCHYARD_MAX_SAMPLES = 360;
export const SWITCHYARD_MAX_EXPERIMENTS = 20;
export const SWITCHYARD_MAX_BYTES = 10_000_000;
export const SWITCHYARD_MAX_GAP_MS = 150_000;
export const SHADOW_TRACKS = ["stay", "recenter", "widen"] as const;
export type ShadowTrack = (typeof SHADOW_TRACKS)[number];
export const SHADOW_LABEL = {
  actual: "Actual account",
  stay: "Stay put",
  recenter: "Recenter",
  widen: "Widen",
} as const;
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const publicKey = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    let n = 0n;
    for (const c of value) {
      const i = alphabet.indexOf(c);
      if (i < 0) return false;
      n = n * 58n + BigInt(i);
    }
    const leading = value.length - value.replace(/^1+/, "").length;
    return leading + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2)) === 32;
  }, "Invalid Solana public key");
const time = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const bin = z.number().int().min(-443636).max(443636);
const id = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/);
const recordId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/);
const raw = z.string().regex(/^(0|[1-9]\d{0,29})$/);
export const ObservedRange = z
  .object({ lower: bin, upper: bin })
  .strict()
  .refine((r) => r.lower <= r.upper && r.upper - r.lower < 1400, "Invalid position range");
export const ShadowRange = z
  .object({
    lower: z.number().int().min(-351639).max(351639),
    upper: z.number().int().min(-351639).max(351639),
  })
  .strict()
  .refine((r) => r.lower <= r.upper && r.upper - r.lower < 69, "Shadow ranges support 1–69 bins");
export type ShadowRange = z.infer<typeof ShadowRange>;
export const ShadowPolicy = z
  .object({
    version: z.literal(1),
    edgeBins: z.number().int().min(0).max(20),
    cooldownMs: z.number().int().min(60_000).max(86_400_000),
    widenByBins: z.number().int().min(1).max(34),
    maxWidthBins: z.number().int().min(1).max(69),
    assumedFeeLamports: raw.nullable(),
  })
  .strict();
export type ShadowPolicy = z.infer<typeof ShadowPolicy>;
const source = z
  .object({
    journeyId: z.string().min(1).max(100),
    account: publicKey,
    pool: publicKey,
    owner: publicKey,
    mintX: publicKey,
    mintY: publicKey,
    decX: z.number().int().min(0).max(18),
    decY: z.number().int().min(0).max(18),
    binStep: z.number().int().min(1).max(65535),
  })
  .strict();
export const ShadowDecision = z
  .object({
    id: z.string().min(1).max(110),
    recordId,
    seq: count.refine((n) => n > 0),
    track: z.enum(["recenter", "widen"]),
    policyVersion: z.literal(1),
    observedAt: time,
    recordedAt: time,
    slot: time,
    checkedSlot: time,
    activeId: bin,
    inputRange: ShadowRange,
    target: ShadowRange,
    trigger: z.enum(["out-of-range", "near-edge"]),
    settlement: z.literal("assumed-immediate-after-recording"),
  })
  .strict();
export type ShadowDecision = z.infer<typeof ShadowDecision>;
const holdReason = z.enum([
  "stay",
  "in-range",
  "cooldown",
  "gap",
  "already-centered",
  "width-cap",
  "target-out-of-bounds",
  "proposed",
]);
export const ShadowReading = z
  .object({
    track: z.enum(SHADOW_TRACKS),
    before: ShadowRange,
    after: ShadowRange,
    lastActionBefore: time.nullable(),
    lastActionAfter: time.nullable(),
    covered: z.boolean(),
    reason: holdReason,
    decision: ShadowDecision.nullable(),
  })
  .strict();
export type ShadowReading = z.infer<typeof ShadowReading>;
const point = {
  observedAt: time,
  recordedAt: time,
  slot: time,
  checkedSlot: time,
  rpcKind: z.enum(["relay", "custom", "server"]),
  activeId: bin,
  actualRange: ObservedRange,
};
export const ShadowPoint = z.object(point).strict();
export type ShadowPoint = z.infer<typeof ShadowPoint>;
export const ShadowSample = z
  .object({
    ...point,
    seq: count.refine((n) => n > 0),
    gapReason: z.enum(["none", "missed-interval", "read-error", "paused"]),
    tracks: z.array(ShadowReading).length(3),
  })
  .strict();
export type ShadowSample = z.infer<typeof ShadowSample>;
const experimentShape = z
  .object({
    v: z.literal(1),
    id,
    evidenceId: id,
    suppliedId: id.nullable(),
    provenance: z.enum(["this-device", "import"]),
    label: z.string().trim().min(1).max(80),
    revision: count.refine((n) => n > 0),
    status: z.enum(["running", "paused"]),
    createdAt: time,
    updatedAt: time,
    continuityId: z.string().min(1).max(180).nullable(),
    source,
    seed: ShadowPoint,
    policy: ShadowPolicy,
    samples: z.array(ShadowSample).max(SWITCHYARD_MAX_SAMPLES),
    omittedSamples: count,
    pendingReset: z.enum(["none", "read-error", "paused"]),
    lastAttempt: time.nullable(),
    lastError: z.string().max(350).nullable(),
    recorderLinks: z.array(z.object({ recordId, savedAt: time }).strict()).max(720),
    recorderError: z.string().max(350).nullable(),
  })
  .strict();
export type ShadowExperiment = z.infer<typeof experimentShape>;
export const rangeWidth = (r: ShadowRange) => r.upper - r.lower + 1;
export const rangeCovers = (r: ShadowRange, active: number) =>
  active >= r.lower && active <= r.upper;
export function edgeDistance(r: ShadowRange, active: number) {
  return Math.min(active - r.lower, r.upper - active);
}
const sameRange = (a: ShadowRange, b: ShadowRange) => a.lower === b.lower && a.upper === b.upper;

/** Pure transition: coverage is measured BEFORE any hypothetical action. */
export function shadowTransition(
  track: ShadowTrack,
  before: ShadowRange,
  active: number,
  policy: ShadowPolicy,
  at: number,
  lastAction: number | null,
  gap: boolean,
) {
  const covered = rangeCovers(before, active);
  const base = { after: before, lastActionAfter: lastAction, covered };
  if (track === "stay") return { ...base, reason: "stay" as const, trigger: null };
  if (gap) return { ...base, reason: "gap" as const, trigger: null };
  if (covered && edgeDistance(before, active) >= policy.edgeBins)
    return { ...base, reason: "in-range" as const, trigger: null };
  if (lastAction !== null && at - lastAction < policy.cooldownMs)
    return { ...base, reason: "cooldown" as const, trigger: null };
  const trigger = covered ? ("near-edge" as const) : ("out-of-range" as const);
  let after: ShadowRange;
  if (track === "recenter") {
    const lower = active - Math.floor(rangeWidth(before) / 2);
    after = { lower, upper: lower + rangeWidth(before) - 1 };
    if (sameRange(before, after))
      return { ...base, reason: "already-centered" as const, trigger: null };
  } else {
    const lowerNeed = Math.min(before.lower, active - policy.edgeBins);
    const upperNeed = Math.max(before.upper, active + policy.edgeBins);
    const required = upperNeed - lowerNeed + 1;
    const width = Math.min(
      policy.maxWidthBins,
      Math.max(required, rangeWidth(before) + policy.widenByBins),
    );
    if (width <= rangeWidth(before) || required > policy.maxWidthBins)
      return { ...base, reason: "width-cap" as const, trigger: null };
    const extra = width - required;
    const lower = lowerNeed - Math.floor(extra / 2);
    after = { lower, upper: lower + width - 1 };
  }
  if (!ShadowRange.safeParse(after).success)
    return { ...base, reason: "target-out-of-bounds" as const, trigger: null };
  return { after, lastActionAfter: at, covered, reason: "proposed" as const, trigger };
}
export const decisionId = (evidenceId: string, seq: number, track: ShadowTrack) =>
  evidenceId + ":" + seq + ":" + track;
export const decisionRecordId = (evidenceId: string, seq: number, track: ShadowTrack) =>
  "swdec-" + evidenceId + "-" + seq + "-" + track;

/** Recompute every retained transition; supplied labels cannot turn forecasts into receipts. */
export const SwitchyardExperiment = experimentShape.superRefine((e, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (e.source.journeyId !== "position:" + e.source.account)
    fail("Source Journey identity differs");
  if (!ShadowRange.safeParse(e.seed.actualRange).success)
    fail("Seed exceeds the tested range-policy bounds");
  if (e.source.mintX === e.source.mintY) fail("Pool mints must differ");
  if (
    e.createdAt < e.seed.observedAt ||
    e.updatedAt < e.createdAt ||
    e.seed.checkedSlot < e.seed.slot ||
    e.seed.recordedAt < e.seed.observedAt
  )
    fail("Invalid seed chronology");
  if (e.provenance === "this-device" && (e.id !== e.evidenceId || e.suppliedId !== null))
    fail("Device experiment identity differs");
  if (e.provenance === "import" && (e.status !== "paused" || e.suppliedId === null))
    fail("Imported experiments must remain paused supplied evidence");
  if (e.policy.maxWidthBins < rangeWidth(e.seed.actualRange))
    fail("Width cap is below the seed range");
  if (e.omittedSamples > 0 && e.samples.length !== SWITCHYARD_MAX_SAMPLES)
    fail("Invalid retained window");
  let previous: ShadowSample | undefined;
  const ids = new Set<string>();
  const recordIds = new Set<string>();
  for (let i = 0; i < e.samples.length; i++) {
    const s = e.samples[i]!;
    const prevPoint = previous ?? e.seed;
    if (
      s.seq !== e.omittedSamples + i + 1 ||
      s.checkedSlot < s.slot ||
      s.recordedAt < s.observedAt ||
      s.observedAt <= prevPoint.recordedAt ||
      s.slot < prevPoint.checkedSlot ||
      s.recordedAt > e.updatedAt
    )
      fail("Invalid observation chronology");
    // When the prefix was dropped, earlier virtual ranges are explicitly carried evidence.
    const carried = !previous && e.omittedSamples > 0;
    if (
      !carried &&
      s.observedAt - prevPoint.observedAt > SWITCHYARD_MAX_GAP_MS &&
      s.gapReason === "none"
    )
      fail("Missed interval must be disclosed");
    for (let j = 0; j < SHADOW_TRACKS.length; j++) {
      const r = s.tracks[j]!;
      if (r.track !== SHADOW_TRACKS[j]) fail("Track order differs");
      const prev = previous?.tracks[j];
      if (
        !carried &&
        (!sameRange(r.before, prev?.after ?? e.seed.actualRange) ||
          r.lastActionBefore !== (prev?.lastActionAfter ?? null))
      )
        fail("Virtual history was rewritten");
      if (r.lastActionBefore !== null && r.lastActionBefore >= s.observedAt)
        fail("Action timestamp must predate its next observation");
      const result = shadowTransition(
        r.track,
        r.before,
        s.activeId,
        e.policy,
        s.recordedAt,
        r.lastActionBefore,
        s.gapReason !== "none",
      );
      if (
        !sameRange(result.after, r.after) ||
        result.covered !== r.covered ||
        result.lastActionAfter !== r.lastActionAfter ||
        result.reason !== r.reason
      )
        fail("Recorded transition differs from the sealed policy");
      if (result.trigger === null && r.decision !== null) fail("Non-action has a decision");
      if (result.trigger !== null) {
        const d = r.decision;
        if (
          !d ||
          d.track !== r.track ||
          d.seq !== s.seq ||
          d.id !== decisionId(e.evidenceId, s.seq, r.track) ||
          d.recordId !== decisionRecordId(e.evidenceId, s.seq, r.track) ||
          d.trigger !== result.trigger ||
          d.observedAt !== s.observedAt ||
          d.recordedAt !== s.recordedAt ||
          d.slot !== s.slot ||
          d.checkedSlot !== s.checkedSlot ||
          d.activeId !== s.activeId ||
          !sameRange(d.inputRange, r.before) ||
          !sameRange(d.target, r.after)
        )
          fail("Decision inputs differ from the observation");
        if (d) {
          if (ids.has(d.id) || recordIds.has(d.recordId)) fail("Duplicate decision evidence");
          ids.add(d.id);
          recordIds.add(d.recordId);
        }
      }
    }
    previous = s;
  }
  const links = new Set<string>();
  for (const l of e.recorderLinks) {
    if (links.has(l.recordId) || !recordIds.has(l.recordId))
      fail("Unknown or duplicate Recorder link");
    links.add(l.recordId);
  }
});
export const SwitchyardBundle = z
  .object({
    schema: z.literal("studio-loco/switchyard"),
    v: z.literal(1),
    exportedAt: time,
    experiments: z.array(SwitchyardExperiment).min(1).max(SWITCHYARD_MAX_EXPERIMENTS),
  })
  .strict();
export type SwitchyardBundle = z.infer<typeof SwitchyardBundle>;
export function shadowScorecards(e: ShadowExperiment) {
  const tracks = ["actual", ...SHADOW_TRACKS] as const;
  return tracks.map((track) => {
    const readings = e.samples.map((s) =>
      track === "actual"
        ? {
            covered: rangeCovers(s.actualRange, s.activeId),
            range: s.actualRange,
            active: s.activeId,
            decision: false,
          }
        : {
            covered: s.tracks.find((r) => r.track === track)!.covered,
            range: s.tracks.find((r) => r.track === track)!.before,
            active: s.activeId,
            decision: s.tracks.find((r) => r.track === track)!.decision !== null,
          },
    );
    const inRange = readings.filter((r) => r.covered).length;
    const decisions = readings.filter((r) => r.decision).length;
    const last = readings.at(-1);
    return {
      track,
      samples: readings.length,
      inRange,
      coveragePct: readings.length ? (inRange / readings.length) * 100 : null,
      lastEdgeDistance: last ? edgeDistance(last.range, last.active) : null,
      proposals: track === "actual" ? null : decisions,
      assumedProposalFeesLamports:
        track === "actual" || e.policy.assumedFeeLamports === null
          ? null
          : (BigInt(e.policy.assumedFeeLamports) * BigInt(decisions)).toString(),
    };
  });
}
export function retainedDecisions(e: ShadowExperiment) {
  return e.samples.flatMap((s) => s.tracks.flatMap((r) => (r.decision ? [r.decision] : [])));
}
export function analyzeSwitchyardExport(input: unknown) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (new TextEncoder().encode(text).byteLength > SWITCHYARD_MAX_BYTES)
    throw new Error("Switchyard export exceeds 10 MB");
  const bundle = SwitchyardBundle.parse(typeof input === "string" ? JSON.parse(input) : input);
  const seen = new Set<string>();
  for (const e of bundle.experiments) {
    if (seen.has(e.id)) throw new Error("Duplicate experiment ID");
    seen.add(e.id);
  }
  return {
    source: "local-export" as const,
    chainVerified: false as const,
    executable: false as const,
    model: "range-policy-only" as const,
    experiments: bundle.experiments.map((e) => ({
      id: e.id,
      policyVersion: e.policy.version,
      observationsReported: e.samples.length,
      omittedObservations: e.omittedSamples,
      gapsReported: e.samples.filter((s) => s.gapReason !== "none").length,
      hypotheticalDecisions: retainedDecisions(e).length,
      scorecards: shadowScorecards(e),
    })),
    notice:
      "Supplied evidence only; no independent chain or timestamp verification. Coverage is a fraction of retained observed samples, not time in range. Hypothetical ranges take effect after recording with assumed immediate settlement; balances, fees earned, swaps, slippage and PnL are not modeled. Proposal fee totals use a recorded user assumption and exclude rent. No wallet or execution permission.",
  };
}

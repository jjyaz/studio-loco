/** Local creation and prospective observation. Imported experiments never enter this path. */
import {
  SwitchyardExperiment,
  SwitchyardBundle,
  ShadowPolicy,
  ShadowRange,
  SHADOW_TRACKS,
  SWITCHYARD_MAX_SAMPLES,
  SWITCHYARD_MAX_GAP_MS,
  SWITCHYARD_MAX_BYTES,
  shadowTransition,
  decisionId,
  decisionRecordId,
  retainedDecisions,
  type ShadowPoint,
  type ShadowExperiment,
  type ShadowPolicy as Policy,
  type ShadowSample,
  type ShadowDecision,
} from "../../packages/sdk/src/switchyard";
import { JourneySnapshot, JOURNEY_STALE_MS, journeyId, type JourneyIdentity } from "./journey";
import { newId } from "./recorder";
export * from "../../packages/sdk/src/switchyard";

export function shadowPoint(input: unknown, recordedAt = Date.now()): ShadowPoint {
  const s = JourneySnapshot.parse(input);
  if (s.kind !== "position") throw new Error("Switchyard range policies require an LP position.");
  if (s.checkedSlot < s.slot) throw new Error("Account corroboration moved backwards.");
  return {
    observedAt: s.observedAt,
    recordedAt: Math.max(s.observedAt, recordedAt),
    slot: s.slot,
    checkedSlot: s.checkedSlot,
    rpcKind: s.source,
    activeId: s.activeId,
    actualRange: { lower: s.lower, upper: s.upper },
  };
}
export function createShadowExperiment(o: {
  identity: JourneyIdentity;
  snapshot: unknown;
  label: string;
  policy: Policy;
  continuityId?: string | null;
  now?: number;
}): ShadowExperiment {
  const now = o.now ?? Date.now();
  const s = JourneySnapshot.parse(o.snapshot);
  if (o.identity.kind !== "position" || s.kind !== "position")
    throw new Error("Choose an LP position.");
  if (now < s.observedAt || now - s.observedAt > JOURNEY_STALE_MS)
    throw new Error("Fresh independently checked account state is required.");
  ShadowRange.parse({ lower: s.lower, upper: s.upper });
  const id = newId("switch");
  return SwitchyardExperiment.parse({
    v: 1,
    id,
    evidenceId: id,
    suppliedId: null,
    provenance: "this-device",
    label: o.label,
    revision: 1,
    status: "running",
    createdAt: now,
    updatedAt: now,
    continuityId: o.continuityId ?? null,
    source: {
      journeyId: journeyId(o.identity),
      account: o.identity.account,
      pool: o.identity.pool,
      owner: o.identity.owner,
      mintX: s.mintX,
      mintY: s.mintY,
      decX: s.decX,
      decY: s.decY,
      binStep: s.binStep,
    },
    seed: shadowPoint(s, now),
    policy: ShadowPolicy.parse(o.policy),
    samples: [],
    omittedSamples: 0,
    pendingReset: "none",
    lastAttempt: now,
    lastError: null,
    recorderLinks: [],
    recorderError: null,
  });
}
export function appendShadowObservation(
  e: ShadowExperiment,
  input: unknown,
  now = Date.now(),
): ShadowExperiment {
  if (e.provenance !== "this-device" || e.status !== "running")
    throw new Error("Only running device experiments can receive live observations.");
  const s = JourneySnapshot.parse(input);
  if (
    s.kind !== "position" ||
    s.mintX !== e.source.mintX ||
    s.mintY !== e.source.mintY ||
    s.decX !== e.source.decX ||
    s.decY !== e.source.decY ||
    s.binStep !== e.source.binStep
  )
    throw new Error("Verified source identity changed.");
  if (now < s.observedAt || now - s.observedAt > JOURNEY_STALE_MS)
    throw new Error("Fresh account state is required.");
  const previous = e.samples.at(-1),
    prevPoint = previous ?? e.seed;
  if (s.observedAt <= prevPoint.recordedAt || s.slot < prevPoint.checkedSlot)
    throw new Error("Observation did not advance past retained evidence.");
  const p = shadowPoint(s, Math.max(now, e.updatedAt + 1));
  const seq = e.omittedSamples + e.samples.length + 1;
  const gapReason =
    e.pendingReset !== "none"
      ? e.pendingReset
      : p.observedAt - prevPoint.observedAt > SWITCHYARD_MAX_GAP_MS
        ? "missed-interval"
        : "none";
  const sample: ShadowSample = {
    ...p,
    seq,
    gapReason,
    tracks: SHADOW_TRACKS.map((track, i) => {
      const old = previous?.tracks[i];
      const before = old?.after ?? e.seed.actualRange;
      const lastActionBefore = old?.lastActionAfter ?? null;
      const r = shadowTransition(
        track,
        before,
        p.activeId,
        e.policy,
        p.recordedAt,
        lastActionBefore,
        gapReason !== "none",
      );
      const decision: ShadowDecision | null =
        r.trigger === null
          ? null
          : {
              id: decisionId(e.evidenceId, seq, track),
              recordId: decisionRecordId(e.evidenceId, seq, track),
              seq,
              track: track as "recenter" | "widen",
              policyVersion: 1,
              observedAt: p.observedAt,
              recordedAt: p.recordedAt,
              slot: p.slot,
              checkedSlot: p.checkedSlot,
              activeId: p.activeId,
              inputRange: before,
              target: r.after,
              trigger: r.trigger,
              settlement: "assumed-immediate-after-recording",
            };
      return {
        track,
        before,
        after: r.after,
        lastActionBefore,
        lastActionAfter: r.lastActionAfter,
        covered: r.covered,
        reason: r.reason,
        decision,
      };
    }),
  };
  const samples = [...e.samples, sample].slice(-SWITCHYARD_MAX_SAMPLES);
  const ids = new Set(
    samples.flatMap((x) => x.tracks.flatMap((r) => (r.decision ? [r.decision.recordId] : []))),
  );
  return SwitchyardExperiment.parse({
    ...e,
    samples,
    updatedAt: p.recordedAt,
    omittedSamples: e.omittedSamples + Math.max(0, e.samples.length + 1 - SWITCHYARD_MAX_SAMPLES),
    pendingReset: "none",
    lastAttempt: now,
    lastError: null,
    recorderLinks: e.recorderLinks.filter((l) => ids.has(l.recordId)),
  });
}
export function shadowDecisionFact(e: ShadowExperiment, d: ShadowDecision) {
  if (e.provenance !== "this-device" || !retainedDecisions(e).some((x) => x.id === d.id))
    throw new Error("Decision is not retained device evidence.");
  return {
    id: d.recordId,
    kind: "proposal" as const,
    route: "/app/switchyard",
    cluster: "mainnet-beta",
    wallet: e.source.owner,
    title: "Switchyard · hypothetical " + d.track + " decision",
    links: { proposalId: d.id },
    context: {
      recordType: "switchyard-decision",
      experimentId: e.id,
      decisionId: d.id,
      policyVersion: 1,
      sequence: d.seq,
      sourceJourneyId: e.source.journeyId,
      continuityId: e.continuityId,
      position: e.source.account,
      pool: e.source.pool,
      mintX: e.source.mintX,
      mintY: e.source.mintY,
      binStep: e.source.binStep,
      observedAt: d.observedAt,
      recordedAt: d.recordedAt,
      slot: d.slot,
      checkedSlot: d.checkedSlot,
      activeId: d.activeId,
      track: d.track,
      inputLower: d.inputRange.lower,
      inputUpper: d.inputRange.upper,
      targetLower: d.target.lower,
      targetUpper: d.target.upper,
      trigger: d.trigger,
      edgeBins: e.policy.edgeBins,
      cooldownMs: e.policy.cooldownMs,
      maxWidthBins: e.policy.maxWidthBins,
      widenByBins: e.policy.widenByBins,
      assumedFeeLamports: e.policy.assumedFeeLamports,
      settlement: d.settlement,
    },
    detail:
      "Hypothetical range policy recorded after its input read and before any later sampled outcome. No transaction, balance simulation, fee-income forecast or execution permission.",
  };
}
export function promotionRefusal(e: ShadowExperiment, d: ShadowDecision, now = Date.now()) {
  if (e.provenance !== "this-device")
    return "Imported experiments are read-only supplied evidence.";
  const retained = retainedDecisions(e).find((x) => x.id === d.id);
  if (!retained) return "This decision is no longer retained.";
  if (JSON.stringify(retained) !== JSON.stringify(d))
    return "Decision inputs differ from retained evidence.";
  if (e.lastError) return "Source observation is unavailable. Refresh before comparison.";
  if (now < d.recordedAt || now - d.recordedAt > 120_000)
    return "This decision is historical. Open the account in Planner for a new comparison.";
  if (e.samples.at(-1)?.seq !== d.seq)
    return "A newer observation exists. Use its current decision or start a new Planner comparison.";
  return null;
}
export function exportSwitchyard(rows: ShadowExperiment[], now = Date.now()) {
  const b = SwitchyardBundle.parse({
    schema: "studio-loco/switchyard",
    v: 1,
    exportedAt: now,
    experiments: rows,
  });
  if (new TextEncoder().encode(JSON.stringify(b)).byteLength > SWITCHYARD_MAX_BYTES)
    throw new Error("Switchyard export exceeds 10 MB.");
  return b;
}
export function parseSwitchyardImport(text: string, now = Date.now()) {
  if (new TextEncoder().encode(text).byteLength > SWITCHYARD_MAX_BYTES)
    throw new Error("Switchyard bundle exceeds 10 MB.");
  const b = SwitchyardBundle.parse(JSON.parse(text));
  const seen = new Set<string>();
  return b.experiments.map((e) => {
    if (seen.has(e.id)) throw new Error("Duplicate experiment ID in supplied evidence.");
    seen.add(e.id);
    return SwitchyardExperiment.parse({
      ...e,
      id: newId("switch"),
      suppliedId: e.id,
      provenance: "import",
      revision: 1,
      status: "paused",
      pendingReset: "paused",
      updatedAt: Math.max(now, e.updatedAt),
      recorderLinks: [],
      recorderError: null,
    });
  });
}

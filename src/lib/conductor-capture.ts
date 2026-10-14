import type { Connection } from "@solana/web3.js";
import type { Job } from "./job-control";
import { JobCancelled } from "./job-control";
import { recordFact, getRecord, usingMemoryFallback } from "./recorder-store";
import { redact } from "./recorder";
import {
  getMission,
  appendMissionObservation,
  acknowledgeMissionFact,
  noteMissionError,
} from "./conductor-store";
import { readConductorSnapshot } from "./conductor-chain";
import { evaluateMission, missionPolicyRecordId, type ConductorMission } from "./conductor";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function conductorFacts(
  m: ConductorMission,
): (Parameters<typeof recordFact>[0] & { id: string })[] {
  const common = {
    kind: "review" as const,
    route: "/app/conductor",
    cluster: "mainnet-beta",
    wallet: m.policies[0]!.policy.scope.owner,
    status: "info" as const,
    links: { proposalId: m.id },
  };
  return [
    ...m.policies.map((p) => ({
      ...common,
      id: missionPolicyRecordId(m.id, p.revision),
      title: `Conductor · policy v${p.revision} · ${m.label}`,
      detail:
        "Locally sealed unsigned policy. Read-only preview; no delegated authority or execution enforcement.",
      context: {
        missionId: m.id,
        policyRevision: p.revision,
        policyDigest: p.digest,
        pool: p.policy.scope.pool,
        owner: p.policy.scope.owner,
        mintX: p.policy.scope.mintX,
        mintY: p.policy.scope.mintY,
        position: p.policy.scope.position,
        probesX: p.policy.probesX.join(","),
        probesY: p.policy.probesY.join(","),
        maxImpactBps: p.policy.maxImpactBps,
        maxSwapFeeBps: p.policy.maxSwapFeeBps,
        maxDeployXRaw: p.policy.maxDeployXRaw,
        maxDeployYRaw: p.policy.maxDeployYRaw,
        minSolReserveLamports: p.policy.minSolReserveLamports,
        maxNetworkFeeLamports: p.policy.maxNetworkFeeLamports,
        actions: p.policy.allowedActions.join(","),
        cooldownMs: p.policy.cooldownMs,
        expiresAt: p.policy.expiresAt,
        sealedAt: p.sealedAt,
        adapter: p.policy.adapter,
        executable: false,
      },
    })),
    ...m.samples.map((s) => {
      const p = m.policies[s.policyRevision - 1]!;
      const report = evaluateMission(p.policy, s.snapshot, s.recordedAt);
      return {
        ...common,
        id: s.recordId,
        title: `Conductor · ${report.state} at observation ${s.seq} · ${m.label}`,
        detail:
          "Independent bounded quote probes, separate owner/inventory reads. Not a transaction receipt, continuous compliance, fill guarantee or PnL.",
        context: {
          missionId: m.id,
          policyRevision: s.policyRevision,
          policyDigest: s.policyDigest,
          sampleSeq: s.seq,
          state: report.state,
          observedAt: s.snapshot.observedAt,
          recordedAt: s.recordedAt,
          quoteSlot: s.snapshot.slot,
          ownerSlot: s.snapshot.funds?.slot ?? null,
          positionSlot: s.snapshot.position?.slot ?? null,
          pool: p.policy.scope.pool,
          position: p.policy.scope.position,
          activeBin: s.snapshot.activeId,
          configured: report.probes.length,
          fullQuotes: report.probes.filter((r) => !!r.metrics).length,
          passingProbes: report.probes.filter((r) => r.state === "met").length,
          arrayCoverage: s.snapshot.binArrays.length,
          rpcKind: s.snapshot.rpcKind,
          executable: false,
        },
      };
    }),
  ];
}
/** Repairs only missing matching facts; a temporary Recorder write never gets an acknowledgement. */
export async function repairConductorRecorder(id: string, job: Job) {
  const m = await job.step(getMission(id), 4000, "Mission evidence");
  if (!m) throw new Error("Mission was removed.");
  for (const fact of conductorFacts(m)
    .filter((f) => !m.recorderLinks.some((r) => r.recordId === f.id))
    .slice(0, 20)) {
    job.check();
    const before = await job.step(getRecord(fact.id), 4000, "Recorder link check");
    if (before) {
      if (
        before.kind !== fact.kind ||
        before.provenance !== "this-device" ||
        before.route !== fact.route ||
        before.wallet !== fact.wallet ||
        before.cluster !== fact.cluster ||
        !same(before.context, fact.context) ||
        !same(before.links, fact.links)
      )
        throw new Error("Recorder fact collision; existing evidence was preserved.");
    } else await job.step(recordFact(fact), 4000, "Recorder evidence copy");
    if (usingMemoryFallback())
      throw new Error(
        "Recorder copy is temporary; durable mission evidence is retained for repair.",
      );
    await job.step(acknowledgeMissionFact(id, fact.id), 4000, "Recorder acknowledgement");
  }
}
export async function observeConductorMission(
  connection: Connection,
  id: string,
  job: Job,
  rpcKind: "relay" | "custom",
) {
  const m = await job.step(getMission(id), 4000, "Current mission");
  if (!m) throw new Error("Mission was removed.");
  const p = m.policies.at(-1)!;
  if (Date.now() >= p.policy.expiresAt) throw new Error("Policy has expired. Seal a new revision.");
  try {
    const scope = p.policy.scope;
    const snapshot = await readConductorSnapshot(
      connection,
      {
        pool: scope.pool,
        owner: scope.owner,
        expectedScope: scope,
        probesX: p.policy.probesX,
        probesY: p.policy.probesY,
        position: scope.position ? { account: scope.position, journeyId: scope.journeyId! } : null,
        minimumSlot: Math.max(
          m.samples.at(-1)?.snapshot.slot ?? 0,
          m.samples.at(-1)?.snapshot.funds?.slot ?? 0,
          m.samples.at(-1)?.snapshot.position?.slot ?? 0,
        ),
      },
      job,
      rpcKind,
    );
    job.check();
    await job.step(
      appendMissionObservation(id, m.revision, snapshot),
      4000,
      "Durable mission observation",
    );
    // Evidence is committed before any Recorder copy, so quota errors never erase a measurement.
    let recorderError: string | null = null;
    try {
      await repairConductorRecorder(id, job);
    } catch (e) {
      if (!job.alive() || e instanceof JobCancelled) throw e;
      recorderError = redact(e instanceof Error ? e.message : "Recorder copy pending").slice(
        0,
        300,
      );
    }
    return { mission: await job.step(getMission(id), 4000, "Saved mission"), recorderError };
  } catch (e) {
    if (job.alive() && !(e instanceof JobCancelled))
      await job.step(
        noteMissionError(
          id,
          m.revision,
          redact(e instanceof Error ? e.message : "Read unavailable"),
        ),
        4000,
        "Read gap evidence",
      );
    throw e;
  }
}

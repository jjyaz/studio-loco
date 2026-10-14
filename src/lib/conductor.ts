import { newId } from "./recorder";
import {
  ConductorMission,
  MissionPolicy,
  MissionPolicyRevision,
  MissionSnapshot,
  missionPolicyDigest,
  missionSampleRecordId,
  type MissionPolicy as Policy,
  type MissionSnapshot as Snapshot,
} from "../../packages/sdk/src/conductor";
export * from "../../packages/sdk/src/conductor";

export async function sealMissionPolicy(policy: Policy, revision = 1, now = Date.now()) {
  const parsed = MissionPolicy.parse(policy);
  if (parsed.expiresAt <= now || parsed.expiresAt > now + 30 * 86_400_000)
    throw new Error("Choose an expiry within the next 30 days.");
  return MissionPolicyRevision.parse({
    revision,
    sealedAt: now,
    digest: await missionPolicyDigest(parsed),
    policy: parsed,
  });
}
export function createConductorMission(
  label: string,
  policy: MissionPolicyRevision,
  snapshot: Snapshot,
): ConductorMission {
  const id = newId("mission"),
    now = Math.max(Date.now(), snapshot.observedAt);
  return ConductorMission.parse({
    v: 1,
    id,
    label,
    revision: 1,
    createdAt: policy.sealedAt,
    updatedAt: now,
    status: "paused",
    policies: [policy],
    samples: [
      {
        seq: 1,
        policyRevision: policy.revision,
        policyDigest: policy.digest,
        recordedAt: now,
        snapshot: MissionSnapshot.parse(snapshot),
        recordId: missionSampleRecordId(id, 1),
      },
    ],
    omittedSamples: 0,
    gaps: [],
    omittedGaps: 0,
    recorderLinks: [],
    lastError: null,
    lastAttempt: now,
  });
}

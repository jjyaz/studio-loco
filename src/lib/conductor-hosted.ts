/** Private, read-only hosted copies. None of these contracts grants execution authority. */
import { z } from "zod";
import {
  MissionPolicyRevision,
  MissionSnapshot,
  evaluateMission,
  missionPolicyDigest,
} from "./conductor";
export const HostedMissionConfig = z
  .object({
    v: z.literal(1),
    kind: z.literal("loco-hosted-mission"),
    missionId: z.string().regex(/^[a-z0-9-]{8,70}$/),
    policy: MissionPolicyRevision,
  })
  .strict();
export type HostedMissionConfig = z.infer<typeof HostedMissionConfig>;
export const MissionObserverCursor = z
  .object({
    v: z.literal(1),
    kind: z.literal("mission-observation-counter"),
    count: z.number().int().nonnegative().safe(),
  })
  .strict();
export type MissionObserverCursor = z.infer<typeof MissionObserverCursor>;
export const HostedMissionSample = z
  .object({
    v: z.literal(1),
    kind: z.literal("loco-hosted-sample"),
    policy: MissionPolicyRevision,
    snapshot: MissionSnapshot.nullable(),
    error: z.string().min(1).max(300).nullable(),
  })
  .strict()
  .refine((s) => !!s.snapshot !== !!s.error);
export type HostedMissionSample = z.infer<typeof HostedMissionSample>;
const iso = z.string().datetime({ offset: true });
export const HostedMissionRow = z.object({
  id: z.string().uuid(),
  label: z.string().max(80),
  revision: z.number().int().positive().safe(),
  status: z.enum(["active", "paused"]),
  rule: HostedMissionConfig,
  expires_at: iso,
  last_run_at: iso.nullable(),
  last_ok_at: iso.nullable(),
  last_error: z.string().nullable(),
  consecutive_errors: z.number().int().nonnegative(),
  out_run: MissionObserverCursor.nullable(),
});
export type HostedMissionRow = z.infer<typeof HostedMissionRow>;
export async function validateHostedConfig(raw: unknown, now: number) {
  const c = HostedMissionConfig.parse(raw);
  if ((await missionPolicyDigest(c.policy.policy)) !== c.policy.digest)
    throw new Error("Hosted policy digest differs.");
  if (
    c.policy.sealedAt > now ||
    c.policy.policy.expiresAt <= now ||
    c.policy.policy.expiresAt > now + 30 * 86_400_000
  )
    throw new Error("Hosted policy is future-dated or expired.");
  return c;
}
export function hostedSampleReport(input: unknown, now: number) {
  const sample = HostedMissionSample.parse(input);
  if (!sample.snapshot)
    return { state: "unknown" as const, recordedState: "unknown" as const, detail: sample.error! };
  const recorded = evaluateMission(
    sample.policy.policy,
    sample.snapshot,
    sample.snapshot.observedAt,
  );
  const current = evaluateMission(sample.policy.policy, sample.snapshot, now);
  return {
    state: current.state,
    recordedState: recorded.state,
    detail: current.checks.find((c) => c.code === "freshness")!.detail,
  };
}

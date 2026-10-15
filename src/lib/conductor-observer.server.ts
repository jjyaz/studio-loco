import { JobControl, JobTimeout } from "./job-control";
import { readConductorSnapshot } from "./conductor-chain";
import {
  HostedMissionConfig,
  HostedMissionSample,
  MissionObserverCursor,
  validateHostedConfig,
} from "./conductor-hosted";
import { evaluateMission, MissionSnapshot } from "./conductor";
import { redact } from "./recorder";
import type { Connection } from "@solana/web3.js";
import type { TickOutcome } from "./signal-box";

export async function readHostedMission(connection: Connection, input: unknown, budgetMs = 85_000) {
  const config = await validateHostedConfig(input, Date.now()),
    p = config.policy.policy,
    s = p.scope;
  const ctl = new JobControl(),
    job = ctl.begin()!,
    deadline = Date.now() + Math.min(85_000, budgetMs);
  const bounded = {
    ...job,
    check() {
      job.check();
      if (Date.now() >= deadline) throw new Error("Hosted mission read deadline reached.");
    },
    step<T>(promise: Promise<T>, ms: number, label: string) {
      this.check();
      return job.step(promise, Math.max(1, Math.min(ms, deadline - Date.now())), label);
    },
  };
  try {
    const snapshot = await readConductorSnapshot(
      connection,
      {
        pool: s.pool,
        owner: s.owner,
        probesX: p.probesX,
        probesY: p.probesY,
        expectedScope: s,
        position: s.position ? { account: s.position, journeyId: s.journeyId! } : null,
      },
      bounded,
      "server",
      s.position
        ? async () => ({
            id: s.journeyId!,
            kind: "position" as const,
            account: s.position!,
            pool: s.pool,
            owner: s.owner,
            snapshots: [],
          })
        : undefined,
    );
    bounded.check();
    if (snapshot.rpcKind !== "server" || JSON.stringify(snapshot.scope) !== JSON.stringify(s))
      throw new Error("Hosted observation scope differs.");
    return MissionSnapshot.parse(snapshot);
  } finally {
    ctl.unmount();
    ctl.end(job);
  }
}
export function missionObservationFailure(
  raw: unknown,
  cursor: unknown,
  reason: string,
): TickOutcome<MissionObserverCursor> {
  const c = HostedMissionConfig.parse(raw),
    previous = cursor === null ? 0 : MissionObserverCursor.parse(cursor).count;
  const error = redact(reason).slice(0, 300) || "Hosted read unavailable";
  return {
    ok: false,
    summary: HostedMissionSample.parse({
      v: 1,
      kind: "loco-hosted-sample",
      policy: c.policy,
      snapshot: null,
      error,
    }),
    error,
    outRun: { v: 1, kind: "mission-observation-counter", count: previous + 1 },
    lastProposed: {},
    alert: null,
  };
}
export async function observeHostedMission(
  connection: Connection,
  raw: unknown,
  cursor: unknown,
  budgetMs: number,
  read = readHostedMission,
): Promise<TickOutcome<MissionObserverCursor>> {
  const c = await validateHostedConfig(raw, Date.now()),
    previous = cursor === null ? 0 : MissionObserverCursor.parse(cursor).count;
  try {
    const snapshot = await read(connection, c, budgetMs);
    if (Date.now() >= c.policy.policy.expiresAt)
      throw new Error("Mission policy expired during observation.");
    const report = evaluateMission(c.policy.policy, snapshot, snapshot.observedAt);
    if (
      report.checks.find((c) => c.code === "scope")?.state !== "met" ||
      snapshot.rpcKind !== "server"
    )
      throw new Error("Observed mission scope differs.");
    return {
      ok: true,
      summary: HostedMissionSample.parse({
        v: 1,
        kind: "loco-hosted-sample",
        policy: c.policy,
        snapshot,
        error: null,
      }),
      error: null,
      outRun: { v: 1, kind: "mission-observation-counter", count: previous + 1 },
      lastProposed: {},
      alert: null,
    };
  } catch (e) {
    if (e instanceof JobTimeout) throw e; // shared worker stops before starting another unabortable read
    return missionObservationFailure(
      c,
      cursor,
      e instanceof Error ? e.message : "Read unavailable",
    );
  }
}

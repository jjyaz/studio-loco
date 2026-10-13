/** Independently checked reads and local evidence copies. Never builds, signs or broadcasts. */
import type { Connection } from "@solana/web3.js";
import type { Job } from "./job-control";
import { JobCancelled } from "./job-control";
import { readJourneySnapshot } from "./journey-chain";
import { appendSnapshot } from "./journey";
import { listJourneys, saveJourney } from "./journey-store";
import { journeyError } from "./journey-capture";
import {
  appendShadowObservation,
  shadowDecisionFact,
  retainedDecisions,
  promotionRefusal,
  type ShadowExperiment,
  type ShadowDecision,
} from "./switchyard";
import {
  getShadowExperiment,
  saveShadowExperiment,
  noteShadowReadError,
  acknowledgeShadowFact,
  noteShadowRecorderError,
} from "./switchyard-store";
import { recordFact, getRecord, usingMemoryFallback } from "./recorder-store";

export async function repairShadowRecorder(id: string, job: Job, limit = 20) {
  const e = await job.step(getShadowExperiment(id), 4000, "Switchyard history");
  if (!e || e.provenance !== "this-device") return 0;
  const pending = retainedDecisions(e).filter(
    (d) => !e.recorderLinks.some((l) => l.recordId === d.recordId),
  );
  let written = 0;
  try {
    for (const d of pending.slice(0, Math.min(20, Math.max(1, limit)))) {
      job.check();
      const fact = shadowDecisionFact(e, d);
      const old = await job.step(getRecord(d.recordId), 4000, "Recorder evidence lookup");
      if (old) {
        if (
          old.provenance !== "this-device" ||
          old.kind !== "proposal" ||
          old.route !== fact.route ||
          old.wallet !== fact.wallet ||
          old.cluster !== fact.cluster ||
          Object.entries(fact.context).some(([k, v]) => old.context[k] !== v)
        )
          throw new Error("Recorder ID conflict. The original record was kept.");
      } else {
        await job.step(recordFact(fact), 4000, "Recorder decision evidence");
      }
      if (usingMemoryFallback())
        throw new Error(
          "Flight Recorder is using temporary storage. The durable decision stays in Switchyard; repair its Recorder link later.",
        );
      await job.step(acknowledgeShadowFact(id, d.recordId), 4000, "Recorder evidence link");
      written++;
    }
  } catch (e) {
    if (job.alive() && !(e instanceof JobCancelled))
      await noteShadowRecorderError(id, journeyError(e));
    throw e;
  }
  return written;
}
export async function observeShadowExperiment(o: {
  connection: Connection;
  id: string;
  job: Job;
  source: "relay" | "custom";
}) {
  const { job } = o;
  const e = await job.step(getShadowExperiment(o.id), 4000, "Experiment state");
  if (!e || e.provenance !== "this-device" || e.status !== "running")
    throw new Error("Choose a running device experiment.");
  try {
    const rows = await job.step(listJourneys(), 4000, "Source Journey");
    const j = rows.find(
      (j) =>
        j.id === e.source.journeyId &&
        j.kind === "position" &&
        j.account === e.source.account &&
        j.owner === e.source.owner &&
        j.pool === e.source.pool,
    );
    if (!j)
      throw new Error("The source Journey is no longer tracked. Its retained evidence was kept.");
    const identity = {
      kind: "position" as const,
      account: j.account,
      owner: j.owner,
      pool: j.pool,
    };
    const s = await readJourneySnapshot(
      o.connection,
      identity,
      job,
      o.source,
      j.snapshots.at(-1),
      e.samples.at(-1)?.checkedSlot ?? e.seed.checkedSlot,
    );
    job.check();
    const next = appendShadowObservation(e, s);
    const saved = await job.step(
      saveShadowExperiment(next, e),
      4000,
      "Prospective observation commit",
    );
    // A concurrently newer source watch wins; never overwrite or recreate it.
    try {
      await job.step(saveJourney(appendSnapshot(j, s), j), 4000, "Source Journey observation");
    } catch (error) {
      if (error instanceof JobCancelled) throw error;
    }
    try {
      await repairShadowRecorder(saved.id, job);
    } catch (error) {
      if (error instanceof JobCancelled) throw error;
    }
    job.check();
    return await job.step(getShadowExperiment(saved.id), 4000, "Updated experiment");
  } catch (error) {
    if (job.alive() && !(error instanceof JobCancelled)) {
      await noteShadowReadError(e.id, e.samples.at(-1)?.seq ?? 0, journeyError(error));
    }
    throw error;
  }
}
export interface ShadowSuggestion {
  experimentId: string;
  decisionId: string;
  recordId: string;
  position: string;
  pool: string;
  owner: string;
  option: "recenter" | "widen";
  target: { lower: number; upper: number };
  label: string;
  expiresAt: number;
}
export function suggestionFrom(
  e: ShadowExperiment,
  d: ShadowDecision,
  now = Date.now(),
): ShadowSuggestion {
  const reason = promotionRefusal(e, d, now);
  if (reason) throw new Error(reason);
  return {
    experimentId: e.id,
    decisionId: d.id,
    recordId: d.recordId,
    position: e.source.account,
    pool: e.source.pool,
    owner: e.source.owner,
    option: d.track,
    target: d.target,
    label: e.label,
    expiresAt: d.recordedAt + 120_000,
  };
}
/** URL IDs only resolve a retained LOCAL intent. They never reconstruct executable inputs. */
export async function loadShadowSuggestion(id: string, decisionId: string, now = Date.now()) {
  const e = await getShadowExperiment(id);
  const d = e && retainedDecisions(e).find((d) => d.id === decisionId);
  if (!e || !d) throw new Error("Shadow decision is unavailable on this device.");
  return suggestionFrom(e, d, now);
}

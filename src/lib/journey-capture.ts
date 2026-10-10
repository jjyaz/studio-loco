/** Receipt-driven capture. No wallet, signing or RPC credentials are persisted. */
import type { Connection } from "@solana/web3.js";
import { JobControl, JobCancelled, type Job } from "./job-control";
import { listRecords, recordFact, subscribeRecorder } from "./recorder-store";
import { listBlueprints, subscribeFoundry } from "./foundry-store";
import { listJourneys, saveJourney } from "./journey-store";
import { appendSnapshot, foundryCandidate, journeyId, newJourney } from "./journey";
import { verifyFoundryLink } from "./journey-chain";
import type { FlightRecord } from "./recorder";
import type { SavedBlueprint } from "./foundry-store";
import { redactUrls } from "./format";

export async function captureFoundryReceipt(
  connection: Connection,
  record: FlightRecord,
  blueprint: SavedBlueprint,
  job: Job,
  source: "relay" | "custom",
) {
  const proof = await verifyFoundryLink(
    connection,
    record,
    blueprint.blueprint,
    blueprint.digest,
    job,
    source,
  );
  job.check();
  const rows = await listJourneys();
  job.check();
  const parent = rows.find((j) => j.id === journeyId(proof.identity));
  if (
    parent?.links.some(
      (l) => l.signature === proof.link.signature && l.digest === proof.link.digest,
    )
  )
    return parent;
  if (parent && (parent.owner !== proof.identity.owner || parent.pool !== proof.identity.pool))
    throw new Error("Tracked account identity differs from this receipt.");
  let next = parent ?? newJourney(proof.identity, blueprint.blueprint.name);
  if (next.links.length >= 100)
    throw new Error("This account has 100 receipt links. Export its evidence before archiving it.");
  next = { ...next, links: [...next.links, proof.link] };
  const prev = next.snapshots.at(-1);
  if (
    !prev ||
    (proof.snapshot.slot >= prev.checkedSlot && proof.snapshot.observedAt > prev.observedAt)
  )
    next = appendSnapshot(next, proof.snapshot);
  const saved = await saveJourney(next, parent);
  job.check();
  await recordFact({
    id: `journey-link-${record.id}`,
    kind: "proposal",
    title: `Journey linked · ${proof.link.name} r${proof.link.revision}`,
    route: "/app/journey",
    cluster: "mainnet-beta",
    wallet: proof.identity.owner,
    links: { recordId: record.id },
    context: {
      recordType: "journey-link",
      account: proof.identity.account,
      pool: proof.identity.pool,
      blueprintId: proof.link.blueprintId,
      blueprintRevision: proof.link.revision,
      blueprintDigest: proof.link.digest,
      signature: proof.link.signature,
      chainSlot: proof.link.slot,
      accountVerifiedAt: proof.snapshot.observedAt,
    },
    detail:
      "Confirmed transaction and resulting account identity independently read. Blueprint association is local configuration evidence.",
  });
  return saved;
}
/** Runs on new Recorder revisions and page hydration; unresolved/rejected/imported receipts do not qualify.
 * Attempts are bounded and failed links remain reviewable on the Journey page. */
export function startJourneyCapture(connection: Connection, source: "relay" | "custom") {
  const ctl = new JobControl(),
    attempted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function scan() {
    const job = ctl.begin();
    if (!job) return;
    try {
      const [records, blueprints, journeys] = await Promise.all([
        listRecords(),
        listBlueprints(),
        listJourneys(),
      ]);
      job.check();
      let count = 0;
      for (const r of records) {
        if (count >= 3) break;
        const b = blueprints.find((b) => foundryCandidate(r, b.blueprint, b.digest));
        const signature = r.steps[0]?.signature;
        if (
          !b ||
          !signature ||
          attempted.has(signature) ||
          journeys.some((j) =>
            j.links.some((l) => l.signature === signature && l.digest === b.digest),
          )
        )
          continue;
        attempted.add(signature);
        count++;
        try {
          await captureFoundryReceipt(connection, r, b, job, source);
        } catch (e) {
          if (e instanceof JobCancelled) throw e; /* explicit retry is available in Journey */
        }
        job.check();
      }
    } catch {
      /* storage/RPC errors are shown by the Journey's independent retry path */
    } finally {
      ctl.end(job);
    }
  }
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void scan();
    }, 350);
  };
  const offRecorder = subscribeRecorder(queue),
    offFoundry = subscribeFoundry(queue);
  queue();
  return () => {
    clearTimeout(timer);
    offRecorder();
    offFoundry();
    ctl.unmount();
  };
}
export const journeyError = (e: unknown) =>
  redactUrls(e instanceof Error ? e.message : String(e)).slice(0, 350);

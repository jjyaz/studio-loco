/** Read-only verification of lifecycle chapters. Never builds, signs or broadcasts. */
import type { Connection } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import { assertCluster } from "./tx";
import type { Job } from "./job-control";
import { readJourneySnapshot } from "./journey-chain";
import type { JourneySnapshot } from "./journey";
import {
  ACTION_INSTRUCTIONS,
  Chapter,
  accountAfter,
  chapterId,
  chapterProof,
  summarize,
  type ChapterCandidate,
} from "./continuity";

const T = 15_000;
let discs: Record<string, import("./continuity-proof").InstructionSpec> | null = null;
export async function dlmmDiscriminators(job: Job) {
  if (discs) return discs;
  const sdk = await job.step(loadSdk(), T, "Meteora SDK");
  const wanted = new Set(Object.values(ACTION_INSTRUCTIONS).flat());
  discs = Object.fromEntries(
    sdk.IDL.instructions
      .filter((i) => wanted.has(i.name))
      .map((i) => [i.name, { discriminator: i.discriminator, accounts: i.accounts }]),
  );
  return discs;
}

export async function verifyChapter(
  connection: Connection,
  c: ChapterCandidate,
  kind: "position" | "order",
  before: JourneySnapshot | undefined,
  job: Job,
  source: "relay" | "custom",
  history: JourneySnapshot[] = [],
): Promise<{ chapter: Chapter; snapshot: JourneySnapshot | null }> {
  await job.step(assertCluster(connection, "mainnet-beta"), T, "Mainnet genesis");
  const tx = await job.step(
    connection.getTransaction(c.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
    T,
    "Confirmed action metadata",
  );
  const proof = chapterProof(
    tx,
    { ...c, priorIdentityVerified: !!before },
    await dlmmDiscriminators(job),
  );
  let snapshot: JourneySnapshot | null = null,
    read: "present" | "absent" | "failed" = "failed";
  const { PublicKey } = await import("@solana/web3.js");
  const probe = await job
    .step(
      connection.getAccountInfoAndContext(new PublicKey(c.account), {
        commitment: "confirmed",
        minContextSlot: proof.slot,
      }),
      T,
      "Resulting account read",
    )
    .catch(() => null);
  if (probe && probe.context.slot >= proof.slot) read = probe.value ? "present" : "absent";
  if (read === "present") {
    // Full identity verification (program/discriminator/pool/owner/mints) of the resulting account.
    snapshot = await readJourneySnapshot(
      connection,
      { kind, account: c.account, pool: c.pool, owner: c.owner },
      job,
      source,
      before,
      proof.slot,
      45_000,
    );
  }
  const after = accountAfter(proof.closing, read);
  if (c.action === "close" && after !== "closed")
    throw new Error(
      "Closing instruction confirmed, but no independent read shows the account closed yet.",
    );
  if (c.action !== "close" && after === "unavailable" && !before)
    throw new Error(
      "Resulting account is unavailable at a confirmed read. Nothing is presumed closed.",
    );
  const historicalBefore =
    history.filter((s) => s.checkedSlot <= proof.slot).at(-1) ??
    (before && before.checkedSlot <= proof.slot ? before : null);
  const chapter = Chapter.parse({
    id: chapterId(c.signature, c.step, c.account),
    action: c.action,
    account: c.account,
    pool: c.pool,
    signature: c.signature,
    step: c.step,
    slot: proof.slot,
    verifiedAt: Date.now(),
    instructions: proof.instructions,
    feeLamports: proof.feeLamports,
    recordId: c.recordId,
    planId: c.planId,
    reviewId: c.reviewId,
    alertId: c.alertId,
    before: historicalBefore ? summarize(historicalBefore) : null,
    after: snapshot ? summarize(snapshot) : null,
    accountAfter: after,
  });
  return { chapter, snapshot };
}

/** Local prepared intent + independently read transaction/account evidence. Never signs. */
import type { Connection, Transaction } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import { DLMM_PROGRAM } from "./foundry";
import { isB58Key } from "./account-verify";
import { JobControl, JobCancelled, type Job } from "./job-control";
import { newId, type FlightRecord } from "./recorder";
import { listRecords, recordFact, subscribeRecorder, type Evidence } from "./recorder-store";
import { listJourneys, saveJourney, subscribeJourney } from "./journey-store";
import { appendSnapshot, journeyId, newJourney, type Journey } from "./journey";
import { journeyError } from "./journey-capture";
import { listStrategies, saveStrategy, migrateJourneys } from "./continuity-store";
import { verifyChapter } from "./continuity-chain";
import { flatAccounts, roleIndexes } from "./continuity-proof";
import {
  ACTION_INSTRUCTIONS,
  applyChapter,
  chapterId,
  markStageAttempt,
  type ChapterCandidate,
  type ChapterAction,
  type Strategy,
} from "./continuity";

const priority: Exclude<ChapterAction, "origin">[] = [
  "close",
  "rebalance",
  "withdraw",
  "cancel",
  "claim",
  "deposit",
];
export interface PreparedCandidate extends ChapterCandidate {
  preparedId: string;
  kind: "position" | "order";
  moveId: string | null;
  destinationPool: string | null;
}

/** The shared runner records public instruction identities before signing. No bytes persist. */
export async function prepareContinuityEvidence(o: {
  recordId: string;
  owner: string;
  cluster: string;
  route: string;
  steps: { tx: Transaction }[];
  evidence?: Evidence;
}) {
  if (
    o.cluster !== "mainnet-beta" ||
    !o.steps.some((s) => s.tx.instructions.some((ix) => ix.programId.toBase58() === DLMM_PROGRAM))
  )
    return;
  const sdk = await loadSdk();
  const specs = sdk.IDL.instructions;
  const relevant = o.steps.flatMap((s) => s.tx.instructions).flatMap((ix) => {
    if (ix.programId.toBase58() !== DLMM_PROGRAM) return [];
    const spec = specs.find((s) => s.discriminator.length === 8 && s.discriminator.every((v, i) => ix.data[i] === v));
    return spec && priority.some((a) => ACTION_INSTRUCTIONS[a].includes(spec.name)) ? [spec] : [];
  });
  if (!relevant.length) return;
  // Only pool-less closures require the existing account lookup; swaps never load device history.
  const journeys = relevant.some((s) => roleIndexes(s).pool < 0) ? await listJourneys() : [];
  const facts: Parameters<typeof recordFact>[0][] = [];
  for (const [step, { tx }] of o.steps.entries()) {
    if (step > 255) break; // The Recorder's declared, visible evidence retention limit.
    const targets = new Map<
      string,
      {
        action: Exclude<ChapterAction, "origin">;
        kind: "position" | "order";
        account: string;
        pool: string;
      }
    >();
    for (const ix of tx.instructions) {
      if (ix.programId.toBase58() !== DLMM_PROGRAM) continue;
      const spec = specs.find(
        (s) => s.discriminator.length === 8 && s.discriminator.every((v, i) => ix.data[i] === v),
      );
      if (!spec) continue;
      const action = priority.find((a) => ACTION_INSTRUCTIONS[a].includes(spec.name));
      if (!action) continue; // Account/bin creation and swaps are not liquidity chapters.
      const roles = roleIndexes(spec),
        accounts = flatAccounts(spec.accounts);
      if (
        roles.target < 0 ||
        roles.owner < 0 ||
        !ix.keys[roles.target]?.isWritable ||
        !ix.keys[roles.owner]?.isSigner ||
        ix.keys[roles.owner]?.pubkey.toBase58() !== o.owner
      )
        continue;
      const account = ix.keys[roles.target]!.pubkey.toBase58();
      const previous = journeys.find((j) => j.account === account && j.owner === o.owner);
      const pool = roles.pool >= 0 ? ix.keys[roles.pool]?.pubkey.toBase58() : previous?.pool;
      if (!pool || !isB58Key(pool)) continue;
      const kind = accounts[roles.target]!.name === "limit_order" ? "order" : "position";
      const old = targets.get(account);
      if (!old || priority.indexOf(action) < priority.indexOf(old.action))
        targets.set(account, { action, kind, account, pool });
    }
    for (const t of targets.values())
      facts.push({
        id: newId("ct"),
        kind: "proposal",
        status: "info",
        route: o.route,
        cluster: o.cluster,
        wallet: o.owner,
        title: "Journey intent · " + t.action,
        links: { ...o.evidence?.links, recordId: o.recordId },
        context: {
          recordType: "continuity-prepared",
          txStep: step,
          action: t.action,
          accountKind: t.kind,
          account: t.account,
          pool: t.pool,
          moveId:
            typeof o.evidence?.context?.["ctMoveId"] === "string"
              ? o.evidence.context["ctMoveId"]
              : null,
          destinationPool:
            typeof o.evidence?.context?.["ctMovePool"] === "string"
              ? o.evidence.context["ctMovePool"]
              : null,
          executable: false,
        },
        detail:
          "Public identities extracted from an unsigned SDK instruction. Intent only; independent successful transaction and account reads are still required.",
      });
  }
  await Promise.all(facts.map((f) => recordFact(f)));
  const moveId = o.evidence?.context?.["ctMoveId"],
    destinationPool = o.evidence?.context?.["ctMovePool"];
  if (typeof moveId === "string" && isB58Key(destinationPool)) {
    for (const f of facts.filter((f) => f.context?.["action"] === "withdraw")) {
      const strategies = (await listStrategies()).filter(
        (s) =>
          s.provenance === "verified" &&
          s.accounts.some(
            (a) =>
              a.account === f.context?.["account"] &&
              a.pool === f.context?.["pool"] &&
              a.owner === o.owner &&
              a.verification === "transaction",
          ),
      );
      if (strategies.length !== 1) continue;
      const s = strategies[0]!;
      if (s.stages.some((st) => st.planId === moveId)) continue;
      await saveStrategy(
        {
          ...s,
          stages: [
            ...s.stages,
            {
              planId: moveId,
              sourceAccount: String(f.context!["account"]),
              sourcePool: String(f.context!["pool"]),
              destinationPool,
              destinationAccount: null,
              withdrawal: null,
              deposit: null,
              lastAttempt: "none",
            },
          ],
        },
        s,
      );
    }
  }
}

/** Facts and wallet records must both be local; imports/cloud copies cannot be promoted. */
export function preparedCandidates(records: FlightRecord[]): PreparedCandidate[] {
  const walletRecords = new Map(
    records
      .filter(
        (r) =>
          r.kind === "wallet-action" &&
          r.provenance === "this-device" &&
          r.cluster === "mainnet-beta",
      )
      .map((r) => [r.id, r]),
  );
  const out: PreparedCandidate[] = [];
  for (const f of records) {
    const c = f.context,
      r = f.links.recordId ? walletRecords.get(f.links.recordId) : undefined;
    if (
      f.provenance !== "this-device" ||
      f.kind !== "proposal" ||
      f.cluster !== "mainnet-beta" ||
      c["recordType"] !== "continuity-prepared" ||
      !r ||
      f.wallet !== r.wallet ||
      !isB58Key(r.wallet)
    )
      continue;
    const step = c["txStep"],
      action = c["action"],
      account = c["account"],
      pool = c["pool"],
      kind = c["accountKind"];
    if (
      typeof step !== "number" ||
      !Number.isSafeInteger(step) ||
      step < 0 ||
      step > 255 ||
      !priority.includes(action as never) ||
      !isB58Key(account) ||
      !isB58Key(pool) ||
      (kind !== "position" && kind !== "order")
    )
      continue;
    const s = r.steps[step];
    if (s?.phase !== "confirmed" || !s.signature) continue;
    const moveId =
      typeof c["moveId"] === "string" && c["moveId"].length <= 160 ? c["moveId"] : null;
    const destinationPool = isB58Key(c["destinationPool"]) ? String(c["destinationPool"]) : null;
    out.push({
      preparedId: f.id,
      action: action as PreparedCandidate["action"],
      kind,
      account,
      pool,
      owner: r.wallet,
      signature: s.signature,
      step,
      recordId: r.id,
      planId: moveId ?? r.links.proposalId ?? null,
      moveId,
      destinationPool,
      reviewId: r.links.reviewId ?? null,
      alertId: r.links.alertId ?? null,
    });
  }
  return out.sort(
    (a, b) =>
      (walletRecords.get(a.recordId)?.createdAt ?? 0) -
        (walletRecords.get(b.recordId)?.createdAt ?? 0) || a.step - b.step,
  );
}

export function eligibleStrategies(rows: Strategy[], c: PreparedCandidate) {
  return rows.filter(
    (s) =>
      s.provenance === "verified" &&
      (s.accounts.some(
        (a) =>
          a.verification === "transaction" &&
          a.account === c.account &&
          a.pool === c.pool &&
          a.owner === c.owner &&
          a.kind === c.kind,
      ) ||
        (c.action === "deposit" &&
          c.moveId &&
          s.stages.some(
            (st) =>
              st.planId === c.moveId &&
              st.withdrawal &&
              !st.deposit &&
              st.destinationPool === c.pool &&
              s.accounts.some((a) => a.account === st.sourceAccount && a.owner === c.owner),
          ))),
  );
}

export async function captureChapter(
  connection: Connection,
  c: PreparedCandidate,
  strategy: Strategy,
  job: Job,
  source: "relay" | "custom",
) {
  if (eligibleStrategies([strategy], c).length !== 1)
    throw new Error("This action is not bound to the selected local strategy.");
  const id = chapterId(c.signature, c.step, c.account);
  if (strategy.chapters.some((ch) => ch.id === id)) return strategy;
  const rows = await listJourneys();
  job.check();
  const j = rows.find(
    (j) => j.account === c.account && j.owner === c.owner && j.pool === c.pool && j.kind === c.kind,
  );
  const previous = j?.snapshots.at(-1);
  const proof = await verifyChapter(connection, c, c.kind, previous, job, source, j?.snapshots);
  job.check();
  // A URL move pointer cannot change the reviewed destination retained in the verified source stage.
  const move =
    c.action === "withdraw" && c.moveId && c.destinationPool
      ? { id: c.moveId, destinationPool: c.destinationPool }
      : undefined;
  const next = applyChapter(strategy, proof.chapter, {
    kind: c.kind,
    owner: c.owner,
    ...(move ? { move } : {}),
  });
  if (proof.snapshot) {
    const identity = { kind: c.kind, account: c.account, pool: c.pool, owner: c.owner };
    const parent = (await listJourneys()).find((x) => x.id === journeyId(identity));
    job.check();
    if (
      !parent ||
      (proof.snapshot.slot >= (parent.snapshots.at(-1)?.checkedSlot ?? 0) &&
        proof.snapshot.observedAt > (parent.snapshots.at(-1)?.observedAt ?? 0))
    )
      await saveJourney(
        appendSnapshot(parent ?? newJourney(identity, strategy.label), proof.snapshot),
        parent,
      );
  }
  job.check();
  const saved = await saveStrategy(next, strategy);
  job.check();
  await recordFact({
    id: "ct-link-" + c.preparedId,
    kind: "proposal",
    status: "info",
    title: "Journey chapter verified · " + c.action,
    route: "/app/journey",
    cluster: "mainnet-beta",
    wallet: c.owner,
    links: {
      recordId: c.recordId,
      ...(c.reviewId ? { reviewId: c.reviewId } : {}),
      ...(c.planId ? { proposalId: c.planId } : {}),
      ...(c.alertId ? { alertId: c.alertId } : {}),
    },
    context: {
      recordType: "continuity-verified",
      strategyId: saved.id,
      account: c.account,
      pool: c.pool,
      signature: c.signature,
      slot: proof.chapter.slot,
      executable: false,
    },
    detail:
      "Successful native instruction account roles and resulting account identity independently checked. Strategy association is device evidence; token provenance and investment returns are not inferred.",
  });
  return saved;
}

/** A refresh verifies a fact; it never rebuilds or resumes a wallet transaction. */
export async function reconcileContinuity(
  connection: Connection,
  job: Job,
  source: "relay" | "custom",
  selectedId?: string,
  limit = 3,
  attemptedVersions?: Set<string>,
) {
  const caller = job,
    deadline = Date.now() + 90_000;
  job = {
    ...caller,
    check() {
      caller.check();
      if (Date.now() >= deadline)
        throw new Error(
          "Continuity verification exceeded its 90-second budget. Earlier evidence was kept; retry later.",
        );
    },
    async step(p, ms, label) {
      const result = await caller.step(p, Math.max(1, Math.min(ms, deadline - Date.now())), label);
      job.check();
      return result;
    },
  };
  await migrateJourneys(await listJourneys());
  job.check();
  let strategies = await listStrategies();
  const records = await listRecords();
  job.check();
  const versions = new Map(records.map((r) => [r.id, r.updatedAt]));
  const attemptKey = (c: PreparedCandidate) => c.preparedId + ":" + versions.get(c.recordId);
  let verified = 0,
    attempted = 0;
  const errors: string[] = [];
  for (const c of preparedCandidates(records)) {
    if (attemptedVersions?.has(attemptKey(c))) continue;
    const matches = eligibleStrategies(strategies, c).filter(
      (s) => !selectedId || s.id === selectedId,
    );
    if (
      !matches.length ||
      matches.every((s) =>
        s.chapters.some((ch) => ch.id === chapterId(c.signature, c.step, c.account)),
      )
    )
      continue;
    if (attempted >= limit) break;
    attemptedVersions?.add(attemptKey(c));
    attempted++;
    if (matches.length !== 1) {
      errors.push("Ambiguous strategy association. No lineage was promoted.");
      continue;
    }
    const s = matches[0]!;
    try {
      const saved = await captureChapter(connection, c, s, job, source);
      strategies = strategies.map((x) => (x.id === saved.id ? saved : x));
      verified++;
    } catch (e) {
      if (e instanceof JobCancelled) throw e;
      const message = journeyError(e);
      errors.push(message);
      try {
        const current = (await listStrategies()).find((x) => x.id === s.id);
        if (current && current.lastError !== message) {
          const saved = await saveStrategy({ ...current, lastError: message }, current);
          strategies = strategies.map((x) => (x.id === saved.id ? saved : x));
        }
      } catch {
        /* The UI's independent durable-store read surfaces storage failures. */
      }
    }
    job.check();
  }
  // Pending/rejected stage-2 attempts are evidence, not completed destination accounts.
  const marked = new Set<string>();
  for (const r of [...records].sort((a, b) => b.createdAt - a.createdAt)) {
    if (
      r.kind !== "wallet-action" ||
      r.provenance !== "this-device" ||
      r.cluster !== "mainnet-beta"
    )
      continue;
    const moveId = r.context["ctMoveId"];
    if (typeof moveId !== "string") continue;
    const f = records.find(
      (f) =>
        f.provenance === "this-device" &&
        f.context["recordType"] === "continuity-prepared" &&
        f.links.recordId === r.id &&
        (f.context["action"] === "deposit" || f.context["action"] === "withdraw"),
    );
    if (!f) continue;
    for (const s of strategies) {
      if (selectedId && s.id !== selectedId) continue;
      const stage = s.stages.find(
        (st) =>
          st.planId === moveId &&
          (f.context["action"] === "deposit"
            ? st.destinationPool === f.context["pool"]
            : st.sourcePool === f.context["pool"] && st.sourceAccount === f.context["account"]),
      );
      if (
        !stage ||
        stage.deposit ||
        !s.accounts.some((a) => a.account === stage.sourceAccount && a.owner === r.wallet)
      )
        continue;
      if (f.context["action"] === "withdraw" && stage.withdrawal) continue;
      if (marked.has(s.id + moveId)) continue;
      marked.add(s.id + moveId);
      const state = ["failed", "rejected", "expired", "partial"].includes(r.status)
        ? "failed"
        : "pending";
      const next = markStageAttempt(s, moveId, state);
      if (next !== s) {
        const saved = await saveStrategy(next, s);
        strategies = strategies.map((x) => (x.id === saved.id ? saved : x));
      }
    }
  }
  const remaining = preparedCandidates(records).filter(
    (c) =>
      !attemptedVersions?.has(attemptKey(c)) &&
      eligibleStrategies(strategies, c).some(
        (s) =>
          (!selectedId || s.id === selectedId) &&
          !s.chapters.some((ch) => ch.id === chapterId(c.signature, c.step, c.account)),
      ),
  ).length;
  return { verified, attempted, errors, remaining };
}

/** Local pointer resolution never supplies executable amounts or transaction bytes. */
export async function resolveContinuityMove(
  moveId: string,
  owner: string,
  destinationPool: string,
) {
  const matches = (await listStrategies()).filter(
    (s) =>
      s.provenance === "verified" &&
      s.stages.some(
        (st) =>
          st.planId === moveId &&
          st.withdrawal &&
          !st.deposit &&
          st.destinationPool === destinationPool &&
          s.accounts.some((a) => a.account === st.sourceAccount && a.owner === owner),
      ),
  );
  if (matches.length !== 1)
    throw new Error(
      "Verify the source withdrawal in Journey before continuing this move. Completed, ambiguous or unmatched moves cannot be reused.",
    );
  const strategy = matches[0]!,
    stage = strategy.stages.find((x) => x.planId === moveId)!;
  return {
    strategyId: strategy.id,
    moveId,
    label: strategy.label,
    sourceAccount: stage.sourceAccount,
    withdrawal: stage.withdrawal!,
  };
}

export function startContinuityCapture(connection: Connection, source: "relay" | "custom") {
  const ctl = new JobControl();
  let timer: ReturnType<typeof setTimeout> | undefined,
    queued = false,
    stopped = false;
  let lastFingerprint = "";
  let more = false;
  const attemptedVersions = new Set<string>();
  async function scan() {
    if (stopped) return;
    const job = ctl.begin();
    if (!job) {
      queued = true;
      return;
    }
    try {
      const records = await listRecords(),
        journeys = await listJourneys(),
        strategies = await listStrategies();
      job.check();
      const fingerprint =
        records
          .filter(
            (r) => r.kind === "wallet-action" || r.context["recordType"] === "continuity-prepared",
          )
          .map((r) => r.id + ":" + r.updatedAt)
          .join("|") +
        journeys.map((j) => j.id + ":" + j.links.length).join("|") +
        strategies.map((s) => s.id + ":" + s.chapters.length).join("|");
      if (fingerprint === lastFingerprint && !more) return;
      lastFingerprint = fingerprint;
      more = false;
      const report = await reconcileContinuity(
        connection,
        job,
        source,
        undefined,
        3,
        attemptedVersions,
      );
      more = report.remaining > 0;
    } catch {
      /* Explicit retry and storage/RPC error states live in the Journey view. */
    } finally {
      ctl.end(job);
      if ((queued || more) && !stopped) {
        queued = false;
        queue();
      }
    }
  }
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), 650);
  };
  const a = subscribeRecorder(queue),
    b = subscribeJourney(queue);
  queue();
  return () => {
    stopped = true;
    clearTimeout(timer);
    a();
    b();
    ctl.unmount();
  };
}

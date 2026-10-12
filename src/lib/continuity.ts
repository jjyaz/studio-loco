/**
 * Journey Continuity: one strategy identity across verified accounts and lifecycle chapters.
 * Pure model. Nothing here builds, signs or broadcasts transactions, and nothing here stores
 * executable inputs, keypairs or signed bytes. Lineage is never inferred from mints, names,
 * times, amounts, imported/cloud records, query strings or a signature alone.
 */
import { z } from "zod";
import { isB58Key } from "./account-verify";
import { DLMM_PROGRAM } from "./foundry";
import type { FlightRecord } from "./recorder";
import type { Journey, JourneySnapshot } from "./journey";

export const MAX_STRATEGIES = 50;
export const MAX_ACCOUNTS = 20;
export const MAX_CHAPTERS = 200;
export const MAX_STAGES = 20;
export const MAX_TARGETS = 8;
export const CONTINUITY_FORMAT = "studio-loco-continuity/v1";

const key = z.string().refine(isB58Key, "Invalid public address");
const sig = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const raw = z.string().regex(/^(0|[1-9]\d{0,59})$/);
const time = z.number().int().positive().safe();
const bin = z.number().int().min(-443636).max(443636);
export const evidenceText = (n: number) =>
  z
    .string()
    .max(n)
    .refine((s) => !/https?:\/\/|[A-Za-z0-9+/_-]{120,}/i.test(s), "URLs/bytes are not evidence");
const text = evidenceText;

export const CHAPTER_ACTIONS = [
  "origin",
  "deposit",
  "rebalance",
  "claim",
  "withdraw",
  "close",
  "cancel",
] as const;
export type ChapterAction = (typeof CHAPTER_ACTIONS)[number];
/** Exact native DLMM instructions accepted for each lifecycle chapter (installed SDK IDL names). */
export const ACTION_INSTRUCTIONS: Record<ChapterAction, readonly string[]> = {
  origin: ["add_liquidity_by_weight2", "place_limit_order"],
  deposit: [
    "place_limit_order",
    "add_liquidity",
    "add_liquidity2",
    "add_liquidity_by_strategy",
    "add_liquidity_by_strategy2",
    "add_liquidity_by_weight",
    "add_liquidity_by_weight2",
    "add_liquidity_one_side",
    "add_liquidity_one_side_precise",
    "add_liquidity_one_side_precise2",
    "add_liquidity_by_strategy_one_side",
  ],
  rebalance: ["rebalance_liquidity"],
  claim: ["claim_fee", "claim_fee2", "claim_reward", "claim_reward2"],
  withdraw: [
    "remove_liquidity",
    "remove_liquidity2",
    "remove_liquidity_by_range",
    "remove_liquidity_by_range2",
    "remove_all_liquidity",
  ],
  close: [
    "close_position",
    "close_position2",
    "close_position_if_empty",
    "close_limit_order_if_empty",
  ],
  cancel: ["cancel_limit_order"],
};
export const CLOSING_INSTRUCTIONS = ACTION_INSTRUCTIONS.close;
/** A close chapter may arrive inside withdraw-and-close; withdraw instructions are allowed beside it. */
const ACCEPTS: Record<ChapterAction, readonly string[]> = {
  ...ACTION_INSTRUCTIONS,
  close: [
    ...ACTION_INSTRUCTIONS.close,
    ...ACTION_INSTRUCTIONS.withdraw,
    ...ACTION_INSTRUCTIONS.claim,
  ],
};

export const AccountRole = z.enum(["origin", "destination", "member", "watch"]);
export const StrategyAccount = z
  .object({
    kind: z.enum(["position", "order"]),
    account: key,
    pool: key,
    owner: key,
    role: AccountRole,
    /** "transaction" = verified chain binding; "user-supplied" = manual/watch grouping. */
    verification: z.enum(["transaction", "user-supplied"]),
    joinedBy: sig.nullable(),
    fromAccount: key.nullable(),
    joinedAt: time,
    joinedSlot: time.nullable().default(null),
    closed: z.object({ signature: sig, slot: time, verifiedAt: time }).strict().nullable(),
  })
  .strict();
export type StrategyAccount = z.infer<typeof StrategyAccount>;

const MintAmount = z.object({ mint: key, decimals: z.number().int().min(0).max(18), raw }).strict();
export const SnapshotSummary = z
  .object({
    observedAt: time,
    slot: time,
    checkedSlot: time,
    activeId: bin,
    lower: bin.nullable(),
    upper: bin.nullable(),
    holdings: z.array(MintAmount).length(2),
    fees: z.array(MintAmount).length(2),
    claimed: z.array(MintAmount).max(2),
    bins: z.array(z.object({ binId: bin, x: raw, y: raw }).strict()).max(70),
    binCount: z.number().int().nonnegative(),
    accountLamports: raw,
    binStep: z.number().int().min(1).max(65535).nullable().default(null),
    rentMinimumLamports: raw.nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (
      s.checkedSlot < s.slot ||
      (s.lower !== null && s.upper !== null && s.lower > s.upper) ||
      s.binCount < s.bins.length
    )
      ctx.addIssue({ code: "custom", message: "Snapshot sequence or range is invalid" });
    if (
      new Set(s.holdings.map((a) => a.mint)).size !== 2 ||
      new Set(s.bins.map((b) => b.binId)).size !== s.bins.length
    )
      ctx.addIssue({ code: "custom", message: "Snapshot duplicates a mint or bin" });
    for (const a of [...s.fees, ...s.claimed])
      if (!s.holdings.some((h) => h.mint === a.mint && h.decimals === a.decimals))
        ctx.addIssue({ code: "custom", message: "Snapshot mint precision is inconsistent" });
  });
export type SnapshotSummary = z.infer<typeof SnapshotSummary>;

export const Chapter = z
  .object({
    id: z.string().max(180),
    action: z.enum(CHAPTER_ACTIONS),
    account: key,
    pool: key,
    signature: sig,
    step: z.number().int().min(0).max(255),
    slot: time,
    verifiedAt: time,
    instructions: z.array(z.string().max(48)).max(12),
    /** Lamports paid by the owner as fee payer; null when unknown. Never includes rent or transfers. */
    feeLamports: raw.nullable(),
    recordId: z.string().max(80).nullable(),
    planId: text(160).nullable(),
    reviewId: z.string().max(80).nullable(),
    alertId: z.string().max(80).nullable(),
    before: SnapshotSummary.nullable(),
    after: SnapshotSummary.nullable(),
    accountAfter: z.enum(["present", "closed", "unavailable"]),
  })
  .strict();
export type Chapter = z.infer<typeof Chapter>;

export const Stage = z
  .object({
    planId: text(160),
    sourceAccount: key,
    sourcePool: key,
    destinationAccount: key.nullable(),
    destinationPool: key.nullable(),
    withdrawal: z.string().max(180).nullable(),
    deposit: z.string().max(180).nullable(),
    lastAttempt: z.enum(["none", "pending", "failed"]),
  })
  .strict();
export type Stage = z.infer<typeof Stage>;

export const Origin = z
  .object({
    blueprintId: z.string().max(80),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    name: text(80),
    signature: sig,
  })
  .strict();
export type Origin = z.infer<typeof Origin>;

export const StrategySchema = z
  .object({
    v: z.literal(2),
    id: z.string().regex(/^strategy:[a-z0-9:_-]{6,120}$/i),
    label: text(80).pipe(z.string().trim().min(1)),
    provenance: z.enum(["verified", "user-supplied", "import"]),
    revision: z.number().int().positive(),
    createdAt: time,
    updatedAt: time,
    origin: Origin.nullable(),
    conflicts: z.array(Origin).max(10),
    accounts: z.array(StrategyAccount).min(1).max(MAX_ACCOUNTS),
    chapters: z.array(Chapter).max(MAX_CHAPTERS),
    omittedChapters: z.number().int().nonnegative(),
    stages: z.array(Stage).max(MAX_STAGES),
    lastError: text(350).nullable(),
    suppliedId: text(129).nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    const accts = new Set<string>();
    for (const a of s.accounts) {
      if (accts.has(a.account)) ctx.addIssue({ code: "custom", message: "Duplicate account" });
      accts.add(a.account);
      if (a.fromAccount && !s.accounts.some((b) => b.account === a.fromAccount))
        ctx.addIssue({ code: "custom", message: "Ancestor account is not in this strategy" });
      if (a.verification === "transaction" && s.provenance !== "verified")
        ctx.addIssue({
          code: "custom",
          message: "Only verified strategies hold verified accounts",
        });
    }
    const ids = new Set<string>();
    for (const c of s.chapters) {
      if (ids.has(c.id) || c.id !== chapterId(c.signature, c.step, c.account))
        ctx.addIssue({ code: "custom", message: "Chapter identity failed validation" });
      ids.add(c.id);
      if (
        !accts.has(c.account) ||
        !s.accounts.some((a) => a.account === c.account && a.pool === c.pool)
      )
        ctx.addIssue({ code: "custom", message: "Chapter references an unknown account" });
    }
    for (const st of s.stages) {
      if (!accts.has(st.sourceAccount))
        ctx.addIssue({ code: "custom", message: "Stage source is not in this strategy" });
      for (const ref of [st.withdrawal, st.deposit])
        if (ref && !ids.has(ref))
          ctx.addIssue({ code: "custom", message: "Stage references a missing chapter" });
      const withdrawal = s.chapters.find((c) => c.id === st.withdrawal);
      const deposit = s.chapters.find((c) => c.id === st.deposit);
      if (
        withdrawal &&
        (withdrawal.action !== "withdraw" ||
          withdrawal.account !== st.sourceAccount ||
          withdrawal.pool !== st.sourcePool ||
          withdrawal.planId !== st.planId)
      )
        ctx.addIssue({ code: "custom", message: "Stage withdrawal binding is invalid" });
      if (
        deposit &&
        (!withdrawal ||
          deposit.action !== "deposit" ||
          deposit.account !== st.destinationAccount ||
          deposit.pool !== st.destinationPool ||
          deposit.planId !== st.planId ||
          deposit.slot < withdrawal.slot)
      )
        ctx.addIssue({ code: "custom", message: "Stage deposit binding is invalid" });
      if (st.destinationAccount && !accts.has(st.destinationAccount))
        ctx.addIssue({ code: "custom", message: "Stage destination is not in this strategy" });
    }
    for (const a of s.accounts) {
      if (
        a.closed &&
        !s.chapters.some(
          (c) =>
            c.account === a.account &&
            c.signature === a.closed!.signature &&
            c.slot === a.closed!.slot &&
            c.accountAfter === "closed",
        )
      )
        ctx.addIssue({ code: "custom", message: "Closure has no bound chapter" });
      if (a.fromAccount === a.account)
        ctx.addIssue({ code: "custom", message: "Account cannot be its own ancestor" });
      const seen = new Set<string>([a.account]);
      let parent = a.fromAccount;
      while (parent) {
        if (seen.has(parent)) {
          ctx.addIssue({ code: "custom", message: "Cyclic account ancestry" });
          break;
        }
        seen.add(parent);
        parent = s.accounts.find((b) => b.account === parent)?.fromAccount ?? null;
      }
    }
  });
export type Strategy = z.infer<typeof StrategySchema>;

/** Checked against the durable row inside CAS, not against an untrusted caller's copy. */
export function assertStrategyUpdate(previous: Strategy, next: Strategy) {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    previous.id !== next.id ||
    previous.provenance !== next.provenance ||
    previous.createdAt !== next.createdAt ||
    !equal(previous.origin, next.origin)
  )
    throw new Error("Strategy identity and original blueprint are immutable.");
  let removed = 0;
  for (const c of previous.chapters) {
    const retained = next.chapters.find((x) => x.id === c.id);
    if (retained && !equal(c, retained))
      throw new Error("Lifecycle chapter contents are immutable.");
    if (!retained) removed++;
  }
  if (next.omittedChapters !== previous.omittedChapters + removed)
    throw new Error("Chapter retention count does not match the retired evidence.");
  for (const a of previous.accounts) {
    const retained = next.accounts.find((x) => x.account === a.account);
    if (
      !retained ||
      !equal({ ...a, closed: null }, { ...retained, closed: null }) ||
      (a.closed && !equal(a.closed, retained.closed))
    )
      throw new Error("Account identity, ancestry and confirmed closures are immutable.");
  }
  for (const st of previous.stages) {
    const retained = next.stages.find((x) => x.planId === st.planId);
    if (
      !retained ||
      retained.sourceAccount !== st.sourceAccount ||
      retained.sourcePool !== st.sourcePool ||
      retained.destinationPool !== st.destinationPool ||
      (st.withdrawal && retained.withdrawal !== st.withdrawal) ||
      (st.deposit &&
        (st.deposit !== retained.deposit || st.destinationAccount !== retained.destinationAccount))
    )
      throw new Error("Reviewed move identity and confirmed stages are immutable.");
  }
  for (const conflict of previous.conflicts)
    if (!next.conflicts.some((x) => equal(x, conflict)))
      throw new Error("Origin conflicts cannot be discarded.");
}

export const chapterId = (signature: string, step: number, account: string) =>
  `${signature}:${step}:${account}`;
export const strategyIdForOrigin = (o: Pick<Origin, "blueprintId" | "signature">) =>
  `strategy:${o.blueprintId.replace(/[^a-z0-9_-]/gi, "").slice(0, 24)}:${o.signature}`;

export function newStrategy(o: {
  origin: Origin | null;
  account: Omit<StrategyAccount, "joinedAt" | "closed" | "joinedSlot"> & {
    joinedSlot?: number | null;
  };
  label: string;
  provenance: Strategy["provenance"];
  id?: string;
  now?: number;
}): Strategy {
  const now = o.now ?? Date.now();
  return StrategySchema.parse({
    v: 2,
    id: o.id ?? (o.origin ? strategyIdForOrigin(o.origin) : `strategy:manual:${randomId()}`),
    label: o.label,
    provenance: o.provenance,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    origin: o.origin,
    conflicts: [],
    accounts: [{ ...o.account, joinedAt: now, closed: null }],
    chapters: [],
    omittedChapters: 0,
    stages: [],
    lastError: null,
  });
}
function randomId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** v1 per-account Journeys stay untouched; Foundry-linked ones gain a strategy identity.
 * Different blueprint origins on one account are recorded as conflicts, never merged silently. */
export function migrateJourney(j: Journey, now = Date.now()): Strategy | null {
  const first = j.links[0];
  if (!first) return null;
  const origin: Origin = {
    blueprintId: first.blueprintId,
    revision: first.revision,
    digest: first.digest,
    name: first.name,
    signature: first.signature,
  };
  const s = newStrategy({
    origin,
    provenance: "verified",
    label: j.label,
    now,
    account: {
      kind: j.kind,
      account: j.account,
      pool: j.pool,
      owner: j.owner,
      role: "origin",
      verification: "transaction",
      joinedBy: first.signature,
      joinedSlot: first.slot,
      fromAccount: null,
    },
  });
  const conflicts = j.links
    .filter(
      (l) =>
        l.blueprintId !== origin.blueprintId ||
        l.digest !== origin.digest ||
        l.revision !== origin.revision,
    )
    .slice(0, 10)
    .map((l) => ({
      blueprintId: l.blueprintId,
      revision: l.revision,
      digest: l.digest,
      name: l.name,
      signature: l.signature,
    }));
  const chapters = j.links.slice(-MAX_CHAPTERS).map((l) =>
    Chapter.parse({
      id: chapterId(l.signature, 0, j.account),
      action: "origin",
      account: j.account,
      pool: j.pool,
      signature: l.signature,
      step: 0,
      slot: l.slot,
      verifiedAt: j.updatedAt,
      instructions: [l.action === "liquidity" ? "add_liquidity_by_weight2" : "place_limit_order"],
      feeLamports: l.feeLamports,
      recordId: l.recordId,
      planId: null,
      reviewId: null,
      alertId: null,
      before: null,
      after: (() => {
        const snap = j.snapshots.find((x) => x.slot >= l.slot);
        return snap ? summarize(snap) : null;
      })(),
      accountAfter: "present",
    }),
  );
  return StrategySchema.parse({ ...s, conflicts, chapters });
}

/** Recorder context for any wallet action that may become a lifecycle chapter. Within field limits. */
export function continuityContext(o: {
  action: Exclude<ChapterAction, "origin">;
  targets: { account: string; pool: string }[];
}): Record<string, string> {
  const t = o.targets.slice(0, MAX_TARGETS);
  if (!t.every((x) => isB58Key(x.account) && isB58Key(x.pool))) return {};
  return {
    ctVersion: "1",
    ctAction: o.action,
    ctTargets: t.map((x) => x.account).join(","),
    ctPools: t.map((x) => x.pool).join(","),
  };
}

export interface ChapterCandidate {
  action: Exclude<ChapterAction, "origin">;
  account: string;
  pool: string;
  owner: string;
  signature: string;
  step: number;
  recordId: string;
  planId: string | null;
  reviewId: string | null;
  alertId: string | null;
}
/** Only confirmed steps of this-device mainnet wallet records. Failed/unknown steps are not candidates. */
export function chapterCandidates(r: FlightRecord): ChapterCandidate[] {
  const c = r.context;
  if (
    r.kind !== "wallet-action" ||
    r.provenance !== "this-device" ||
    r.cluster !== "mainnet-beta" ||
    c["ctVersion"] !== "1" ||
    !isB58Key(r.wallet) ||
    !(CHAPTER_ACTIONS as readonly string[]).includes(String(c["ctAction"])) ||
    c["ctAction"] === "origin"
  )
    return [];
  const targets = String(c["ctTargets"] ?? "").split(","),
    pools = String(c["ctPools"] ?? "").split(",");
  if (targets.length !== pools.length || targets.length > MAX_TARGETS) return [];
  const out: ChapterCandidate[] = [];
  r.steps.forEach((s, i) => {
    // One target applies to every step (multi-transaction actions); otherwise targets align with steps.
    const account = targets.length === 1 ? targets[0] : targets[i],
      pool = pools.length === 1 ? pools[0] : pools[i];
    if (s.phase !== "confirmed" || !s.signature || !isB58Key(account) || !isB58Key(pool)) return;
    out.push({
      action: c["ctAction"] as ChapterCandidate["action"],
      account,
      pool,
      owner: r.wallet,
      signature: s.signature,
      step: i,
      recordId: r.id,
      planId: r.links.proposalId ?? null,
      reviewId: r.links.reviewId ?? null,
      alertId: r.links.alertId ?? null,
    });
  });
  return out;
}

export { chapterProof } from "./continuity-proof";

/** Closure needs both a closing instruction and an independent read that finds no account. */
export function accountAfter(
  closing: boolean,
  read: "present" | "absent" | "failed",
): Chapter["accountAfter"] {
  if (read === "present") return "present";
  if (read === "absent" && closing) return "closed";
  return "unavailable";
}

export function summarize(s: JourneySnapshot): SnapshotSummary {
  const amt = (mint: string, decimals: number, v: string) => ({ mint, decimals, raw: v });
  return SnapshotSummary.parse({
    observedAt: s.observedAt,
    slot: s.slot,
    checkedSlot: s.checkedSlot,
    activeId: s.activeId,
    lower: s.kind === "position" ? s.lower : null,
    upper: s.kind === "position" ? s.upper : null,
    holdings: [amt(s.mintX, s.decX, s.holdingsX), amt(s.mintY, s.decY, s.holdingsY)],
    fees: [amt(s.mintX, s.decX, s.feeX), amt(s.mintY, s.decY, s.feeY)],
    claimed:
      s.kind === "position"
        ? [amt(s.mintX, s.decX, s.claimedX), amt(s.mintY, s.decY, s.claimedY)]
        : [],
    bins:
      s.kind === "position"
        ? s.bins
            .filter((b) => b.x !== "0" || b.y !== "0")
            .slice(0, 70)
            .map(({ binId, x, y }) => ({ binId, x, y }))
        : s.levels.slice(0, 70).map((l) => ({ binId: l.binId, x: l.unfilledX, y: l.unfilledY })),
    binCount: s.kind === "position" ? s.bins.length : s.levels.length,
    accountLamports: s.accountLamports,
    binStep: s.binStep,
    rentMinimumLamports: s.rentMinimumLamports,
  });
}

export interface MintRow {
  mint: string;
  decimals: number;
  before: string | null;
  after: string | null;
  delta: string | null;
}
/** Joins by mint address, so a destination pool with reversed X/Y orientation compares correctly.
 * Snapshots are observations at different slots — not atomic state, PnL or output attribution. */
export function compareByMint(
  before: SnapshotSummary | null,
  after: SnapshotSummary | null,
  field: "holdings" | "fees" | "claimed",
): MintRow[] {
  const mints = new Map<string, number>();
  for (const s of [before, after]) for (const a of s?.[field] ?? []) mints.set(a.mint, a.decimals);
  return [...mints].map(([mint, decimals]) => {
    const b = before?.[field].find((a) => a.mint === mint)?.raw ?? null,
      a = after?.[field].find((x) => x.mint === mint)?.raw ?? null;
    return {
      mint,
      decimals,
      before: b,
      after: a,
      delta: b !== null && a !== null ? (BigInt(a) - BigInt(b)).toString() : null,
    };
  });
}

/** Owner-paid network fees, deduplicated by signature. Unknown fees stay unknown; no rent/transfer inference. */
export function strategyCosts(s: Strategy) {
  const bySig = new Map<string, Set<string>>();
  for (const c of s.chapters) {
    const fees = bySig.get(c.signature) ?? new Set<string>();
    if (c.feeLamports !== null) fees.add(c.feeLamports);
    bySig.set(c.signature, fees);
  }
  let total = 0n,
    unknown = 0;
  for (const fees of bySig.values()) fees.size !== 1 ? unknown++ : (total += BigInt([...fees][0]!));
  return { lamports: total.toString(), transactions: bySig.size, unknown };
}

export type StageStatus =
  "pending" | "withdrawal-confirmed" | "deposit-pending" | "complete" | "interrupted";
export function stageStatus(st: Stage): StageStatus {
  if (st.withdrawal && st.deposit) return "complete";
  if (st.lastAttempt === "failed") return "interrupted";
  if (!st.withdrawal) return "pending";
  if (st.lastAttempt === "pending") return "deposit-pending";
  return "withdrawal-confirmed";
}

/** Idempotent by signature/step/account. Returns the same object when nothing changes. */
export function applyChapter(
  s: Strategy,
  ch: Chapter,
  ctx: {
    kind: "position" | "order";
    owner: string;
    move?: { id: string; destinationPool: string };
  },
): Strategy {
  if (s.provenance !== "verified")
    throw new Error("Only verified strategies accept chain chapters.");
  const parsed = Chapter.parse(ch);
  if (s.chapters.some((c) => c.id === parsed.id)) return s;
  let accounts = [...s.accounts];
  let stages = [...s.stages];
  const member = accounts.find((a) => a.account === parsed.account);
  if (member && member.verification !== "transaction")
    throw new Error("Watch-only grouping cannot receive verified chapters.");
  if (member && member.owner !== ctx.owner)
    throw new Error("Chapter signer differs from the account owner.");
  if (member?.joinedSlot && parsed.slot < member.joinedSlot)
    throw new Error("Action precedes this account's strategy origin.");
  if (!member) {
    // Only a verified stage-2 deposit for a known plan may add a destination account.
    const st = parsed.planId ? stages.find((x) => x.planId === parsed.planId) : undefined;
    const src = st && accounts.find((a) => a.account === st.sourceAccount);
    if (
      parsed.action !== "deposit" ||
      !st?.withdrawal ||
      st.deposit ||
      !src ||
      src.verification !== "transaction"
    )
      throw new Error("Destination is not bound to a verified source withdrawal in this strategy.");
    if (src.owner !== ctx.owner)
      throw new Error("Destination signer differs from the source owner.");
    if (!st.destinationPool || st.destinationPool !== parsed.pool)
      throw new Error("Destination differs from the locally reviewed pool move.");
    const withdrawal = s.chapters.find((c) => c.id === st.withdrawal)!;
    const basis = withdrawal.after ?? withdrawal.before;
    if (!basis || !parsed.after || !sameSnapshotPair(basis, parsed.after))
      throw new Error("Source and destination mint identities differ or are unavailable.");
    if (parsed.slot < s.chapters.find((c) => c.id === st.withdrawal)!.slot)
      throw new Error("Destination deposit precedes its source withdrawal.");
    if (accounts.length >= MAX_ACCOUNTS)
      throw new Error("Strategy account limit reached. Export before adding.");
    accounts.push({
      kind: ctx.kind,
      account: parsed.account,
      pool: parsed.pool,
      owner: ctx.owner,
      role: "destination",
      verification: "transaction",
      joinedBy: parsed.signature,
      fromAccount: src.account,
      joinedAt: parsed.verifiedAt,
      joinedSlot: parsed.slot,
      closed: null,
    });
    stages = stages.map((x) =>
      x === st
        ? {
            ...x,
            destinationAccount: parsed.account,
            destinationPool: parsed.pool,
            deposit: parsed.id,
            lastAttempt: "none" as const,
          }
        : x,
    );
  } else {
    if (member.pool !== parsed.pool)
      throw new Error("Chapter pool differs from the verified account pool.");
    if (parsed.accountAfter === "closed")
      accounts = accounts.map((a) =>
        a.account === parsed.account
          ? {
              ...a,
              closed: {
                signature: parsed.signature,
                slot: parsed.slot,
                verifiedAt: parsed.verifiedAt,
              },
            }
          : a,
      );
    if (parsed.action === "withdraw" || parsed.action === "close") {
      if (parsed.action === "withdraw" && ctx.move) {
        const existing = stages.find((x) => x.planId === ctx.move!.id);
        if (
          existing &&
          (existing.sourceAccount !== parsed.account ||
            existing.sourcePool !== parsed.pool ||
            existing.destinationPool !== ctx.move.destinationPool)
        )
          throw new Error("Move intent differs from this verified source withdrawal.");
        if (existing && !existing.withdrawal)
          stages = stages.map((x) =>
            x === existing ? { ...x, withdrawal: parsed.id, lastAttempt: "none" as const } : x,
          );
      }
      if (
        parsed.action === "withdraw" &&
        ctx.move &&
        !stages.some((x) => x.planId === ctx.move!.id)
      ) {
        if (stages.length >= MAX_STAGES) throw new Error("Staged move limit reached.");
        stages.push({
          planId: ctx.move.id,
          sourceAccount: parsed.account,
          sourcePool: parsed.pool,
          destinationAccount: null,
          destinationPool: ctx.move.destinationPool,
          withdrawal: parsed.id,
          deposit: null,
          lastAttempt: "none",
        });
      }
    }
  }
  const chapters = [...s.chapters, parsed].sort((a, b) => a.slot - b.slot || a.step - b.step);
  const protectedIds = new Set([
    ...chapters
      .filter((c) => c.signature === s.origin?.signature && c.action === "origin")
      .map((c) => c.id),
    ...stages.flatMap((x) => [x.withdrawal, x.deposit].filter((id): id is string => id !== null)),
    ...accounts
      .filter((a) => a.closed)
      .map(
        (a) =>
          chapters.find(
            (c) =>
              c.signature === a.closed!.signature &&
              c.account === a.account &&
              c.accountAfter === "closed",
          )!.id,
      ),
  ]);
  const protectedChapters = chapters.filter((c) => protectedIds.has(c.id));
  const retained = new Set(
    [
      ...protectedChapters,
      ...chapters
        .filter((c) => !protectedIds.has(c.id))
        .slice(-(MAX_CHAPTERS - protectedChapters.length)),
    ].map((c) => c.id),
  );
  return StrategySchema.parse({
    ...s,
    accounts,
    stages,
    chapters: chapters.filter((c) => retained.has(c.id)),
    omittedChapters: s.omittedChapters + Math.max(0, chapters.length - MAX_CHAPTERS),
    lastError: null,
  });
}

export function sameSnapshotPair(a: SnapshotSummary, b: SnapshotSummary) {
  return (
    a.holdings.length === b.holdings.length &&
    a.holdings.every((x) => b.holdings.some((y) => x.mint === y.mint && x.decimals === y.decimals))
  );
}

/** Records a failed/pending stage-2 attempt, without adding any account. */
export function markStageAttempt(
  s: Strategy,
  planId: string,
  state: "pending" | "failed",
): Strategy {
  const st = s.stages.find((x) => x.planId === planId);
  if (!st || st.deposit || st.lastAttempt === state) return s;
  return StrategySchema.parse({
    ...s,
    stages: s.stages.map((x) => (x === st ? { ...x, lastAttempt: state } : x)),
  });
}

export function strategyForAccount(rows: Strategy[], account: string) {
  return rows.filter(
    (s) =>
      s.provenance === "verified" &&
      s.accounts.some((a) => a.account === account && a.verification === "transaction"),
  );
}

/** User-supplied grouping: watch-only accounts are labelled and never become verified ancestry. */
export function manualStrategy(
  label: string,
  a: { kind: "position" | "order"; account: string; pool: string; owner: string },
  now = Date.now(),
) {
  return newStrategy({
    origin: null,
    provenance: "user-supplied",
    label,
    now,
    account: {
      ...a,
      role: "watch",
      verification: "user-supplied",
      joinedBy: null,
      fromAccount: null,
    },
  });
}

export const ContinuityBundle = z
  .object({
    format: z.literal(CONTINUITY_FORMAT),
    exportedAt: z.string().datetime().max(40),
    notice: z.string().max(400),
    strategies: z.array(StrategySchema).max(MAX_STRATEGIES),
  })
  .strict();
export type ContinuityBundle = z.infer<typeof ContinuityBundle>;

export function exportContinuity(rows: Strategy[], now = Date.now()): ContinuityBundle {
  const bundle = ContinuityBundle.parse({
    format: CONTINUITY_FORMAT,
    exportedAt: new Date(now).toISOString(),
    notice:
      "User-supplied device evidence. Public identifiers and observations only: no credentials, RPC URLs, keypairs, executable inputs or signed bytes. Not authenticated chain history.",
    strategies: rows.map((s) => StrategySchema.parse(s)),
  });
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > 10_000_000)
    throw new Error("Continuity bundle exceeds 10 MB. Export individual strategies.");
  return bundle;
}

/** Imports are labelled supplied evidence. They never enter capture or become verified lineage. */
export function parseContinuityImport(
  input: unknown,
  now = Date.now(),
): { strategies: Strategy[]; rejected: number } {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (new TextEncoder().encode(text).byteLength > 10_000_000)
    throw new Error("Continuity bundle exceeds 10 MB.");
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  const envelope = z
    .object({
      format: z.literal(CONTINUITY_FORMAT),
      exportedAt: z.string().datetime(),
      notice: z.string().max(400),
      strategies: z.array(z.unknown()).max(MAX_STRATEGIES),
    })
    .strict()
    .parse(raw);
  const list = envelope.strategies;
  const strategies: Strategy[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_STRATEGIES)) {
    const p = StrategySchema.safeParse(item);
    if (!p.success || seen.has(p.data.id)) {
      rejected++;
      continue;
    }
    seen.add(p.data.id);
    strategies.push(
      StrategySchema.parse({
        ...p.data,
        id: "strategy:import:" + randomId(),
        suppliedId: p.data.suppliedId ?? p.data.id,
        provenance: "import",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        accounts: p.data.accounts.map((a) => ({ ...a, verification: "user-supplied" as const })),
        lastError: null,
      }),
    );
  }
  return { strategies, rejected };
}

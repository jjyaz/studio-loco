/** The Journey: observations, never transaction inputs or investment performance. */
import { z } from "zod";
import { isB58Key } from "./account-verify";
import { blueprintDigest, parseBlueprint, DLMM_PROGRAM, type Blueprint } from "./foundry";
import type { FlightRecord } from "./recorder";

export const JOURNEY_POLL_MS = 60_000;
export const JOURNEY_STALE_MS = 150_000;
export const MAX_JOURNEYS = 100;
const key = z.string().refine(isB58Key, "Enter a valid Solana public address");
const raw = z.string().regex(/^(0|[1-9]\d{0,59})$/);
const time = z.number().int().positive().safe();
const bin = z.number().int().min(-443636).max(443636);
export const JourneyIdentity = z
  .object({
    kind: z.enum(["position", "order"]),
    account: key,
    pool: key,
    owner: key,
  })
  .strict();
export type JourneyIdentity = z.infer<typeof JourneyIdentity>;
export const JourneyLink = z
  .object({
    recordId: z.string().max(80),
    signature: z.string().max(88),
    slot: time,
    blueprintId: z.string().max(80),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().max(80),
    action: z.enum(["liquidity", "buy", "sell"]),
    feeLamports: raw,
  })
  .strict();
export type JourneyLink = z.infer<typeof JourneyLink>;
const basis = {
  observedAt: time,
  slot: time,
  checkedSlot: time,
  source: z.enum(["relay", "custom", "server"]),
  mintX: key,
  mintY: key,
  decX: z.number().int().min(0).max(18),
  decY: z.number().int().min(0).max(18),
  binStep: z.number().int().min(1).max(65535),
  activeId: bin,
  accountLamports: raw,
  rentMinimumLamports: raw,
  holdingsX: raw,
  holdingsY: raw,
  feeX: raw,
  feeY: raw,
};
export const OrderLevel = z
  .object({
    binId: bin,
    side: z.enum(["buy", "sell"]),
    state: z.enum(["resting", "partial", "filled"]),
    depositX: raw,
    depositY: raw,
    unfilledX: raw,
    unfilledY: raw,
    filledX: raw,
    filledY: raw,
    proceedsX: raw,
    proceedsY: raw,
  })
  .strict();
export const JourneySnapshot = z.discriminatedUnion("kind", [
  z
    .object({
      ...basis,
      kind: z.literal("position"),
      lower: bin,
      upper: bin,
      feeOwner: key,
      claimedX: raw,
      claimedY: raw,
      bins: z.array(z.object({ binId: bin, x: raw, y: raw, shares: raw }).strict()).max(1400),
    })
    .strict(),
  z
    .object({
      ...basis,
      kind: z.literal("order"),
      levels: z.array(OrderLevel).max(70),
      unfilledX: raw,
      unfilledY: raw,
      filledX: raw,
      filledY: raw,
      proceedsX: raw,
      proceedsY: raw,
    })
    .strict(),
]);
export type JourneySnapshot = z.infer<typeof JourneySnapshot>;
export const JourneyEvent = z
  .object({
    id: z.string().max(180),
    at: time,
    after: time.nullable(),
    slot: time,
    kind: z.enum(["baseline", "range", "level", "fees", "link"]),
    detail: z.string().max(350),
  })
  .strict();
export type JourneyEvent = z.infer<typeof JourneyEvent>;
export const JourneySchema = JourneyIdentity.extend({
  v: z.literal(1),
  id: z.string().max(150),
  label: z.string().trim().min(1).max(80),
  revision: z.number().int().positive(),
  createdAt: time,
  updatedAt: time,
  links: z.array(JourneyLink).max(100),
  snapshots: z.array(JourneySnapshot).max(48),
  events: z.array(JourneyEvent).max(200),
  omittedSnapshots: z.number().int().nonnegative(),
  omittedEvents: z.number().int().nonnegative(),
  lastError: z.string().max(350).nullable(),
  lastAttempt: time.nullable(),
}).strict();
export type Journey = z.infer<typeof JourneySchema>;
export const journeyId = (i: JourneyIdentity) => `${i.kind}:${i.account}`;
export function newJourney(i: JourneyIdentity, label: string, now = Date.now()): Journey {
  return JourneySchema.parse({
    ...i,
    v: 1,
    id: journeyId(i),
    label,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    links: [],
    snapshots: [],
    events: [],
    omittedSnapshots: 0,
    omittedEvents: 0,
    lastError: null,
    lastAttempt: null,
  });
}
export function rangeHealth(s: Extract<JourneySnapshot, { kind: "position" }>) {
  return s.activeId < s.lower || s.activeId > s.upper
    ? "out of range"
    : Math.min(s.activeId - s.lower, s.upper - s.activeId) < 3
      ? "near edge"
      : "in range";
}
export function snapshotHealth(j: Journey, now = Date.now()) {
  if (j.lastError) return "unavailable";
  const s = j.snapshots.at(-1);
  if (!s) return "waiting";
  return now < s.observedAt || now - s.observedAt > JOURNEY_STALE_MS ? "stale" : "verified";
}
/** First read is a baseline. Changes are interval observations, never exact fill timestamps. */
export function observationEvents(
  prev: JourneySnapshot | undefined,
  next: JourneySnapshot,
): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  const add = (kind: JourneyEvent["kind"], detail: string, suffix = kind as string) =>
    out.push({
      id: `${next.observedAt}:${next.slot}:${suffix}`,
      at: next.observedAt,
      after: prev?.observedAt ?? null,
      slot: next.slot,
      kind,
      detail,
    });
  if (!prev) {
    add("baseline", "First verified account snapshot. Earlier activity is not reconstructed.");
    return out;
  }
  if (prev.kind !== next.kind) throw new Error("Account type changed.");
  if (next.kind === "position" && prev.kind === "position") {
    const state = rangeHealth(next);
    if (state !== rangeHealth(prev) || next.lower !== prev.lower || next.upper !== prev.upper)
      add("range", `${state} · active bin ${next.activeId}, range ${next.lower}–${next.upper}.`);
    if (
      BigInt(next.claimedX) > BigInt(prev.claimedX) ||
      BigInt(next.claimedY) > BigInt(prev.claimedY)
    )
      add(
        "fees",
        "Cumulative claimed-fee counters increased. Recipient and proceeds are not inferred.",
      );
  }
  if (next.kind === "order" && prev.kind === "order") {
    for (const l of next.levels) {
      const old = prev.levels.find((p) => p.binId === l.binId && p.side === l.side);
      if (!old || old.state !== l.state || old.filledX !== l.filledX || old.filledY !== l.filledY)
        add(
          "level",
          `${l.side} bin ${l.binId} · ${l.state}${!old ? " (newly observed level)" : " observed"}.`,
          `level:${l.side}:${l.binId}`,
        );
    }
    for (const old of prev.levels)
      if (!next.levels.some((l) => l.binId === old.binId && l.side === old.side))
        add(
          "level",
          `${old.side} bin ${old.binId} · withdrawn/reset observed: the verified account no longer holds this level. Cause and exact time unverified.`,
          `removed:${old.side}:${old.binId}`,
        );
  }
  return out;
}
export function appendSnapshot(j: Journey, input: unknown): Journey {
  const s = JourneySnapshot.parse(input),
    prev = j.snapshots.at(-1);
  if (s.kind !== j.kind) throw new Error("Snapshot account type differs from this Journey.");
  if (
    s.checkedSlot < s.slot ||
    (prev && (s.slot < prev.checkedSlot || s.observedAt <= prev.observedAt))
  )
    throw new Error("The RPC observation moved backwards. Previous evidence was kept.");
  if (
    prev &&
    (s.mintX !== prev.mintX ||
      s.mintY !== prev.mintY ||
      s.binStep !== prev.binStep ||
      s.decX !== prev.decX ||
      s.decY !== prev.decY)
  )
    throw new Error("Verified pool identity changed. Previous evidence was kept.");
  const events = [...j.events, ...observationEvents(prev, s)],
    snapshots = [...j.snapshots, s];
  return JourneySchema.parse({
    ...j,
    snapshots: snapshots.slice(-48),
    events: events.slice(-200),
    omittedSnapshots: j.omittedSnapshots + Math.max(0, snapshots.length - 48),
    omittedEvents: j.omittedEvents + Math.max(0, events.length - 200),
    lastAttempt: s.observedAt,
    lastError: null,
  });
}
/** Only local runner receipts can be candidates. A candidate still needs independent chain proof. */
export function foundryCandidate(r: FlightRecord, b: Blueprint, digest: string) {
  const c = r.context;
  if (
    r.kind !== "wallet-action" ||
    r.provenance !== "this-device" ||
    r.cluster !== "mainnet-beta" ||
    c["recordType"] !== "foundry-action" ||
    c["blueprintId"] !== b.id ||
    c["blueprintRevision"] !== b.revision ||
    c["blueprintDigest"] !== digest ||
    c["pool"] !== b.pool ||
    !["liquidity", "buy", "sell"].includes(String(c["foundryAction"]))
  )
    return null;
  const step = r.steps.length === 1 && r.steps[0]?.phase === "confirmed" ? r.steps[0] : null;
  if (!step?.signature || !isB58Key(r.wallet) || !isB58Key(c["targetAccount"])) return null;
  const action = c["foundryAction"] as JourneyLink["action"];
  return {
    ...JourneyIdentity.parse({
      kind: action === "liquidity" ? "position" : "order",
      account: c["targetAccount"],
      pool: b.pool,
      owner: r.wallet,
    }),
    action,
    signature: step.signature,
  };
}
export async function validateCandidate(r: FlightRecord, b: Blueprint, digest: string) {
  const blueprint = parseBlueprint(b);
  if ((await blueprintDigest(blueprint)) !== digest)
    throw new Error("Blueprint integrity check failed.");
  const c = foundryCandidate(r, blueprint, digest);
  if (!c)
    throw new Error("A confirmed local Foundry action and exact saved revision are required.");
  return c;
}
/** Confirmed transaction must contain a native DLMM instruction binding both exact accounts. */
export function transactionProof(
  t: import("@solana/web3.js").VersionedTransactionResponse | null,
  identity: JourneyIdentity,
  discriminator: Uint8Array,
) {
  if (!t?.meta || t.meta.err !== null)
    throw new Error("Successful transaction metadata is unavailable.");
  const m = t.transaction.message;
  const keys = m.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
  let ownerIndex = -1,
    targetIndex = -1,
    poolIndex = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = keys.get(i)?.toBase58();
    if (k === identity.owner) ownerIndex = i;
    if (k === identity.account) targetIndex = i;
    if (k === identity.pool) poolIndex = i;
  }
  if (
    ownerIndex < 0 ||
    !m.isAccountSigner(ownerIndex) ||
    targetIndex < 0 ||
    !m.isAccountWritable(targetIndex) ||
    poolIndex < 0
  )
    throw new Error("Transaction does not bind the expected signer, writable account and pool.");
  if (
    discriminator.length !== 8 ||
    !m.compiledInstructions.some(
      (ix) =>
        keys.get(ix.programIdIndex)?.toBase58() === DLMM_PROGRAM &&
        discriminator.every((v, i) => ix.data[i] === v) &&
        ix.accountKeyIndexes.includes(targetIndex) &&
        ix.accountKeyIndexes.includes(poolIndex) &&
        ix.accountKeyIndexes.includes(ownerIndex),
    )
  )
    throw new Error("No expected native Foundry instruction binds this owner, account and pool.");
  if (
    !Number.isSafeInteger(t.slot) ||
    t.slot < 1 ||
    !Number.isSafeInteger(t.meta.fee) ||
    t.meta.fee < 0
  )
    throw new Error("Transaction slot or network fee is invalid.");
  // The fee is charged to the fee payer, which can differ from the position owner.
  return { slot: t.slot, feeLamports: ownerIndex === 0 ? String(t.meta.fee) : "0" };
}

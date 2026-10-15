/**
 * Conductor operation ledger (pure contracts + deterministic transitions).
 * A budget is a local, unsigned, opt-in cumulative ceiling. It is never delegated
 * authority: every spend still needs a fresh wallet approval by the matching owner.
 * v1 mission policies remain per-operation top-up ceilings and grant no budget.
 */
import { z } from "zod";
import { AddressSchema } from "./contracts.js";
import { MissionRaw, MISSION_ACTIONS } from "./conductor.js";

const time = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9-]{8,70}$/);

export const OPERATION_STATES = [
  "proposed",
  "reviewed",
  "reserved",
  "signed",
  "submitted",
  "confirmed",
  "failed",
  "rejected",
  "expired",
  "unknown",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** States whose reservation still counts as unresolved liability. */
export const HOLDING_STATES: readonly OperationState[] = ["reserved", "signed", "submitted", "unknown"];
/** States that may never release a reservation without independent definitive evidence. */
export const BROADCAST_STATES: readonly OperationState[] = ["submitted", "unknown"];

const ALLOWED: Record<OperationState, readonly OperationState[]> = {
  proposed: ["reviewed", "rejected", "expired"],
  reviewed: ["reserved", "rejected", "expired"],
  reserved: ["signed", "rejected", "expired"],
  // Signed but not yet broadcast: refusal before sending can still release.
  signed: ["submitted", "rejected", "expired", "unknown"],
  submitted: ["confirmed", "failed", "expired", "unknown"],
  unknown: ["confirmed", "failed", "expired"],
  confirmed: [],
  failed: [],
  rejected: [],
  expired: [],
};

export const BudgetScope = z
  .object({
    missionId: id,
    owner: AddressSchema,
    cluster: z.enum(["mainnet-beta", "devnet"]),
    pool: AddressSchema,
    mintX: AddressSchema,
    mintY: AddressSchema,
  })
  .strict();
export type BudgetScope = z.infer<typeof BudgetScope>;

export const ExecutionBudget = z
  .object({
    v: z.literal(1),
    kind: z.literal("cumulative-execution-budget"),
    scope: BudgetScope,
    revision: z.number().int().min(1),
    policyDigest: hash,
    totalXRaw: MissionRaw,
    totalYRaw: MissionRaw,
    totalLamports: MissionRaw,
    allowedActions: z.array(z.enum(MISSION_ACTIONS)).min(1).max(3),
    expiresAt: time,
  })
  .strict();
export type ExecutionBudget = z.infer<typeof ExecutionBudget>;

export const Spend = z.object({ xRaw: MissionRaw, yRaw: MissionRaw, lamports: MissionRaw }).strict();
export type Spend = z.infer<typeof Spend>;

export const Operation = z
  .object({
    id,
    scope: BudgetScope,
    budgetRevision: z.number().int().min(1),
    policyDigest: hash,
    action: z.enum(MISSION_ACTIONS),
    state: z.enum(OPERATION_STATES),
    reserved: Spend,
    consumed: Spend.nullable(),
    messageHash: hash.nullable(),
    signature: z.string().max(100).nullable(),
    blockhash: z.string().max(60).nullable(),
    lastValidBlockHeight: z.number().int().nonnegative().nullable(),
    evidence: z.string().max(500).nullable(),
    history: z.array(z.object({ state: z.enum(OPERATION_STATES), at: time }).strict()).min(1),
  })
  .strict();
export type Operation = z.infer<typeof Operation>;

const ZERO: Spend = { xRaw: "0", yRaw: "0", lamports: "0" };
const add = (a: Spend, b: Spend): Spend => ({
  xRaw: (BigInt(a.xRaw) + BigInt(b.xRaw)).toString(),
  yRaw: (BigInt(a.yRaw) + BigInt(b.yRaw)).toString(),
  lamports: (BigInt(a.lamports) + BigInt(b.lamports)).toString(),
});
const sameScope = (a: BudgetScope, b: BudgetScope) =>
  a.missionId === b.missionId &&
  a.owner === b.owner &&
  a.cluster === b.cluster &&
  a.pool === b.pool &&
  a.mintX === b.mintX &&
  a.mintY === b.mintY;

/**
 * Cumulative totals across ALL budget revisions in the same scope:
 * policy changes never reset spent capital or drop pending liability.
 */
export function ledgerTotals(scope: BudgetScope, ops: readonly Operation[]) {
  let consumed = ZERO,
    reserved = ZERO,
    unresolved = 0;
  for (const op of ops) {
    if (!sameScope(op.scope, scope)) continue;
    if (op.state === "confirmed") consumed = add(consumed, op.consumed ?? op.reserved);
    // A landed-but-failed transaction still charged its verified network cost.
    else if (op.state === "failed" && op.consumed) consumed = add(consumed, op.consumed);
    else if (HOLDING_STATES.includes(op.state)) {
      reserved = add(reserved, op.reserved);
      unresolved++;
    }
  }
  return { consumed, reserved, unresolved };
}

export function remaining(budget: ExecutionBudget, ops: readonly Operation[]): Spend {
  const t = ledgerTotals(budget.scope, ops);
  const left = (cap: string, c: string, r: string) => {
    const v = BigInt(cap) - BigInt(c) - BigInt(r);
    return (v > 0n ? v : 0n).toString();
  };
  return {
    xRaw: left(budget.totalXRaw, t.consumed.xRaw, t.reserved.xRaw),
    yRaw: left(budget.totalYRaw, t.consumed.yRaw, t.reserved.yRaw),
    lamports: left(budget.totalLamports, t.consumed.lamports, t.reserved.lamports),
  };
}

export type ReserveRefusal =
  | "no-budget"
  | "scope"
  | "stale-revision"
  | "digest"
  | "expired"
  | "action"
  | "exceeds";

/** Fails closed. `latestRevision` must come from the same atomic read as `ops`. */
export function checkReservation(
  budget: ExecutionBudget | null,
  latestRevision: number | null,
  op: Pick<Operation, "scope" | "budgetRevision" | "policyDigest" | "action" | "reserved">,
  ops: readonly Operation[],
  now: number,
): { ok: true } | { ok: false; reason: ReserveRefusal } {
  if (!budget) return { ok: false, reason: "no-budget" };
  if (!sameScope(budget.scope, op.scope)) return { ok: false, reason: "scope" };
  if (latestRevision !== budget.revision || op.budgetRevision !== budget.revision)
    return { ok: false, reason: "stale-revision" };
  if (op.policyDigest !== budget.policyDigest) return { ok: false, reason: "digest" };
  if (now >= budget.expiresAt) return { ok: false, reason: "expired" };
  if (!budget.allowedActions.includes(op.action)) return { ok: false, reason: "action" };
  const left = remaining(budget, ops);
  if (
    BigInt(op.reserved.xRaw) > BigInt(left.xRaw) ||
    BigInt(op.reserved.yRaw) > BigInt(left.yRaw) ||
    BigInt(op.reserved.lamports) > BigInt(left.lamports)
  )
    return { ok: false, reason: "exceeds" };
  return { ok: true };
}

export interface TransitionEvidence {
  signature?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  messageHash?: string;
  consumed?: Spend;
  /** Required to release a broadcast operation as failed/expired. */
  independentlyVerified?: boolean;
  evidence?: string;
}

export function transition(op: Operation, next: OperationState, at: number, ev: TransitionEvidence = {}): Operation {
  if (!ALLOWED[op.state].includes(next))
    throw new Error(`Illegal operation transition ${op.state} → ${next}`);
  const wasBroadcast = BROADCAST_STATES.includes(op.state);
  if (wasBroadcast && (next === "failed" || next === "expired") && !ev.independentlyVerified)
    throw new Error("A broadcast operation releases only on independently verified failure or expiry");
  if (next === "signed" && (!ev.signature || !ev.blockhash || !ev.messageHash))
    throw new Error("Signature, blockhash and message hash must persist before broadcast");
  if (wasBroadcast && next === "failed" && !ev.consumed)
    throw new Error("A broadcast failure must record its verified charged cost (zero if it never landed)");
  if (next === "confirmed" && (!ev.consumed || !ev.independentlyVerified))
    throw new Error("Confirmation needs independently verified spend");
  if (op.messageHash && ev.messageHash && ev.messageHash !== op.messageHash)
    throw new Error("Message hash changed after signing");
  return Operation.parse({
    ...op,
    state: next,
    signature: ev.signature ?? op.signature,
    blockhash: ev.blockhash ?? op.blockhash,
    lastValidBlockHeight: ev.lastValidBlockHeight ?? op.lastValidBlockHeight,
    messageHash: ev.messageHash ?? op.messageHash,
    consumed: next === "confirmed" || next === "failed" ? (ev.consumed ?? op.consumed) : op.consumed,
    evidence: ev.evidence ?? op.evidence,
    history: [...op.history, { state: next, at }],
  });
}

/** Deletion may never erase unresolved obligations. */
export function canDeleteMissionLedger(scope: BudgetScope, ops: readonly Operation[]) {
  return ledgerTotals(scope, ops).unresolved === 0;
}

/** Supplied operation evidence analysis. No chain authentication, import permission or signing. */
import { z } from "zod";
import {
  ConductorBundle,
  analyzeMissionExport,
  type ConductorMission,
  exportMission,
} from "./conductor.js";
import {
  ExecutionBudget,
  Operation,
  ledgerTotals,
  remaining,
  OPERATION_TRANSITIONS,
} from "./ledger.js";
const time = z.number().int().positive().safe();
const BudgetRecord = z
  .object({
    key: z.string().max(80),
    missionId: z.string().max(70),
    sealedAt: time,
    budget: ExecutionBudget,
  })
  .strict();
const OperationRecord = z
  .object({
    id: z.string().max(70),
    missionId: z.string().max(70),
    row: z.number().int().positive().safe(),
    op: Operation,
  })
  .strict();
export const OperationLedgerBundle = z
  .object({
    v: z.literal(1),
    kind: z.literal("loco-operation-ledger"),
    interpretation: z.literal("supplied-read-only-evidence"),
    mission: ConductorBundle,
    budgets: z.array(BudgetRecord).max(20),
    operations: z.array(OperationRecord).max(200),
  })
  .strict();
export function exportOperationLedger(
  mission: ConductorMission,
  budgets: z.infer<typeof BudgetRecord>[],
  operations: z.infer<typeof OperationRecord>[],
) {
  return OperationLedgerBundle.parse({
    v: 1,
    kind: "loco-operation-ledger",
    interpretation: "supplied-read-only-evidence",
    mission: exportMission(mission),
    budgets,
    operations,
  });
}
export async function analyzeOperationLedger(input: unknown) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 4_000_000)
    throw new Error("Operation evidence exceeds 4 MB.");
  const b = OperationLedgerBundle.parse(typeof input === "string" ? JSON.parse(input) : input);
  await analyzeMissionExport(b.mission);
  const m = b.mission.mission,
    scope = m.policies[0]!.policy.scope;
  const scopeMatches = (s: ExecutionBudget["scope"]) =>
    s.missionId === m.id &&
    s.cluster === "mainnet-beta" &&
    s.owner === scope.owner &&
    s.pool === scope.pool &&
    s.mintX === scope.mintX &&
    s.mintY === scope.mintY;
  for (let i = 0; i < b.budgets.length; i++) {
    const r = b.budgets[i]!,
      p = m.policies.find((p) => p.digest === r.budget.policyDigest);
    if (
      !p ||
      !scopeMatches(r.budget.scope) ||
      r.missionId !== m.id ||
      r.key !== `${m.id}#${String(r.budget.revision).padStart(4, "0")}` ||
      r.budget.revision !== i + 1 ||
      r.sealedAt < p.sealedAt ||
      r.budget.expiresAt > p.policy.expiresAt ||
      r.budget.expiresAt <= r.sealedAt ||
      r.budget.allowedActions.some((a) => !p.policy.allowedActions.includes(a)) ||
      (i > 0 && r.sealedAt < b.budgets[i - 1]!.sealedAt)
    )
      throw new Error("Budget evidence binding/history differs.");
  }
  if (new Set(b.operations.map((r) => r.id)).size !== b.operations.length)
    throw new Error("Duplicate operation evidence.");
  for (const r of b.operations) {
    const op = r.op,
      budget = b.budgets.find((b) => b.budget.revision === op.budgetRevision);
    if (
      r.id !== op.id ||
      r.missionId !== m.id ||
      !scopeMatches(op.scope) ||
      !budget ||
      budget.budget.policyDigest !== op.policyDigest ||
      !budget.budget.allowedActions.includes(op.action) ||
      op.history[0]!.state !== "proposed" ||
      op.history[0]!.at < budget.sealedAt ||
      op.history.at(-1)!.state !== op.state ||
      op.history.length > 10
    )
      throw new Error("Operation evidence binding/history differs.");
    for (let i = 1; i < op.history.length; i++)
      if (
        op.history[i]!.at < op.history[i - 1]!.at ||
        !OPERATION_TRANSITIONS[op.history[i - 1]!.state].includes(op.history[i]!.state)
      )
        throw new Error("Illegal supplied operation history.");
    if (
      op.history.some((h) => h.state === "signed") &&
      (!op.signature || !op.blockhash || !op.messageHash || op.lastValidBlockHeight === null)
    )
      throw new Error("Signed operation evidence is incomplete.");
    if (["confirmed", "failed"].includes(op.state) && !op.consumed)
      throw new Error("Supplied settled spending is missing.");
  }
  const latest = b.budgets.at(-1)?.budget,
    ops = b.operations.map((r) => r.op);
  return {
    interpretation: "supplied-read-only-evidence" as const,
    independentlyVerified: false as const,
    executable: false as const,
    missionId: m.id,
    budgetRevisions: b.budgets.length,
    operations: ops.length,
    latest: latest
      ? {
          revision: latest.revision,
          ...ledgerTotals(latest.scope, ops),
          remaining: remaining(latest, ops),
        }
      : null,
    note: "Hashes and history bindings are checked; reported receipts/spending are supplied evidence, not authenticated chain execution. No wallet or reservation authority is granted.",
  };
}

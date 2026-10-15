/**
 * Durable Conductor operation ledger and cumulative budgets (IndexedDB only).
 * Every reservation/transition reads the latest budget and all scope obligations and
 * writes in ONE readwrite transaction, so tabs cannot double-reserve. No in-memory
 * fallback, no TTL release. Operations originate only from local code paths; nothing
 * imported can create one.
 */
import {
  ExecutionBudget,
  Operation,
  checkReservation,
  transition,
  ledgerTotals,
  remaining,
  type OperationState,
  type TransitionEvidence,
} from "../../packages/sdk/src/ledger";
import { ConductorMission } from "./conductor";
import { BUDGETS, OPERATIONS, ledgerTx, notifyConductor } from "./conductor-store";

export const MAX_BUDGET_REVISIONS = 20;
export const MAX_OPERATIONS = 200;
export const TERMINAL: readonly OperationState[] = ["confirmed", "failed", "rejected", "expired"];

export interface BudgetRow {
  key: string;
  missionId: string;
  sealedAt: number;
  budget: ExecutionBudget;
}
export interface OperationRow {
  id: string;
  missionId: string;
  row: number;
  op: Operation;
}
const budgetKey = (m: string, r: number) => `${m}#${String(r).padStart(4, "0")}`;

function all<T>(store: IDBObjectStore, missionId: string, cb: (rows: T[]) => void) {
  const r = store.getAll();
  r.onsuccess = () => cb((r.result as (T & { missionId: string })[]).filter((x) => x.missionId === missionId));
}
const latestOf = (rows: BudgetRow[]) =>
  rows.reduce<BudgetRow | null>((a, b) => (!a || b.budget.revision > a.budget.revision ? b : a), null);

export async function listLedger(missionId: string) {
  return ledgerTx<{ budgets: BudgetRow[]; operations: OperationRow[] }>(
    [BUDGETS, OPERATIONS],
    "readonly",
    (t, done, fail) => {
      all<BudgetRow>(t.objectStore(BUDGETS), missionId, (budgets) =>
        all<OperationRow>(t.objectStore(OPERATIONS), missionId, (operations) => {
          try {
            budgets.forEach((b) => ExecutionBudget.parse(b.budget));
            operations.forEach((o) => Operation.parse(o.op));
          } catch {
            fail("Stored ledger data is invalid; nothing can be reserved.");
            return;
          }
          done({
            budgets: budgets.sort((a, b) => a.budget.revision - b.budget.revision),
            operations: operations.sort((a, b) => a.op.history[0]!.at - b.op.history[0]!.at),
          });
        }),
      );
    },
  );
}

export function summarize(budgets: BudgetRow[], operations: OperationRow[], now = Date.now()) {
  const latest = latestOf(budgets);
  if (!latest) return null;
  const ops = operations.map((o) => o.op);
  const t = ledgerTotals(latest.budget.scope, ops);
  return {
    budget: latest.budget,
    ...t,
    remaining: remaining(latest.budget, ops),
    expired: now >= latest.budget.expiresAt,
  };
}

/** Seal a new immutable budget revision. `expected` is the latest revision the caller saw. */
export async function sealBudget(budget: ExecutionBudget, expected: number | null, now = Date.now()) {
  const b = ExecutionBudget.parse(budget);
  if (b.expiresAt <= now || b.expiresAt > now + 30 * 86_400_000)
    throw new Error("Choose a budget expiry within the next 30 days.");
  await ledgerTx<void>(["missions", BUDGETS, OPERATIONS], "readwrite", (t, done, fail) => {
    const m = t.objectStore("missions").get(b.scope.missionId);
    m.onsuccess = () => {
      let mission: ConductorMission;
      try {
        mission = ConductorMission.parse(m.result);
      } catch {
        fail("This mission is not stored on this device.");
        return;
      }
      const p = mission.policies.at(-1)!,
        s = p.policy.scope;
      if (s.pool !== b.scope.pool || s.owner !== b.scope.owner || s.mintX !== b.scope.mintX || s.mintY !== b.scope.mintY || b.scope.cluster !== "mainnet-beta")
        return fail("Budget scope does not match the mission's pool, owner and mints.");
      if (p.digest !== b.policyDigest) return fail("Budget must bind the mission's latest sealed policy.");
      all<BudgetRow>(t.objectStore(BUDGETS), b.scope.missionId, (rows) => {
        const latest = latestOf(rows)?.budget.revision ?? null;
        if (latest !== expected || b.revision !== (latest ?? 0) + 1)
          return fail("The budget changed in another tab. Reload before sealing.");
        if (rows.length >= MAX_BUDGET_REVISIONS)
          return fail(`Budget history is full (${MAX_BUDGET_REVISIONS} revisions retained). No revision was sealed.`);
        all<OperationRow>(t.objectStore(OPERATIONS), b.scope.missionId, (ops) => {
          const tot = ledgerTotals(b.scope, ops.map((o) => o.op));
          const below = (cap: string, a: string, r: string) => BigInt(cap) < BigInt(a) + BigInt(r);
          if (
            below(b.totalXRaw, tot.consumed.xRaw, tot.reserved.xRaw) ||
            below(b.totalYRaw, tot.consumed.yRaw, tot.reserved.yRaw) ||
            below(b.totalLamports, tot.consumed.lamports, tot.reserved.lamports)
          )
            return fail("A new budget cannot be smaller than already consumed plus unresolved amounts.");
          const add = t.objectStore(BUDGETS).add({ key: budgetKey(b.scope.missionId, b.revision), missionId: b.scope.missionId, sealedAt: now, budget: b } satisfies BudgetRow);
          add.onsuccess = () => done(undefined);
        });
      });
    };
  });
  notifyConductor();
}

/** Record an immutable proposed intent. Local callers only — there is no import path. */
export async function proposeOperation(op: Operation) {
  const o = Operation.parse(op);
  if (o.state !== "proposed" || o.history.length !== 1 || o.consumed || o.signature)
    throw new Error("New operations start as a clean proposal.");
  await ledgerTx<void>([OPERATIONS], "readwrite", (t, done, fail) => {
    const s = t.objectStore(OPERATIONS);
    all<OperationRow>(s, o.scope.missionId, (rows) => {
      if (rows.some((r) => r.id === o.id)) return fail("Duplicate operation id.");
      if (rows.some((r) => !TERMINAL.includes(r.op.state)))
        return fail("Another operation for this mission is still active. Resolve it first.");
      if (rows.length >= MAX_OPERATIONS)
        return fail(`Operation history is full (${MAX_OPERATIONS} retained). Export and start a new mission; nothing was truncated.`);
      const add = s.add({ id: o.id, missionId: o.scope.missionId, row: 1, op: o } satisfies OperationRow);
      add.onsuccess = () => done(undefined);
    });
  });
  notifyConductor();
}

/** CAS transition. Reservation and pre-sign checks use the latest budget in the same transaction. */
export async function transitionOperation(
  id: string,
  expectedRow: number,
  next: OperationState,
  ev: TransitionEvidence = {},
  now = Date.now(),
) {
  const result = await ledgerTx<OperationRow>([BUDGETS, OPERATIONS], "readwrite", (t, done, fail) => {
    const s = t.objectStore(OPERATIONS),
      g = s.get(id);
    g.onsuccess = () => {
      const row = g.result as OperationRow | undefined;
      if (!row) return fail("Operation not found.");
      if (row.row !== expectedRow) return fail("Operation changed in another tab. Reload first.");
      all<BudgetRow>(t.objectStore(BUDGETS), row.missionId, (budgets) =>
        all<OperationRow>(s, row.missionId, (rows) => {
          const latest = latestOf(budgets);
          if (next === "reserved" || next === "signed") {
            const others = rows.filter((r) => r.id !== id).map((r) => r.op);
            const check = checkReservation(latest?.budget ?? null, latest?.budget.revision ?? null, row.op, others, now);
            if (!check.ok) return fail(`Budget check refused: ${check.reason}.`);
          }
          let op: Operation;
          try {
            op = transition(row.op, next, now, ev);
          } catch (e) {
            return fail(e instanceof Error ? e.message : "Transition refused.");
          }
          const updated: OperationRow = { ...row, row: row.row + 1, op };
          const put = s.put(updated);
          put.onsuccess = () => done(updated);
        }),
      );
    };
  });
  notifyConductor();
  return result;
}

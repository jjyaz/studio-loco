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
  r.onsuccess = () =>
    cb((r.result as (T & { missionId: string })[]).filter((x) => x.missionId === missionId));
}
const latestOf = (rows: BudgetRow[]) =>
  rows.reduce<BudgetRow | null>(
    (a, b) => (!a || b.budget.revision > a.budget.revision ? b : a),
    null,
  );
function validRows(budgets: BudgetRow[], operations: OperationRow[]) {
  for (const b of budgets) {
    ExecutionBudget.parse(b.budget);
    if (
      b.missionId !== b.budget.scope.missionId ||
      b.key !== budgetKey(b.missionId, b.budget.revision)
    )
      throw new Error("Stored budget binding is invalid.");
  }
  for (const r of operations) {
    Operation.parse(r.op);
    if (
      r.id !== r.op.id ||
      r.missionId !== r.op.scope.missionId ||
      !Number.isSafeInteger(r.row) ||
      r.row < 1 ||
      r.op.history.at(-1)?.state !== r.op.state
    )
      throw new Error("Stored operation binding is invalid.");
  }
}
function policyBinding(m: ConductorMission, b: ExecutionBudget, now: number) {
  const p = m.policies.at(-1)!;
  const s = p.policy.scope;
  if (
    b.scope.missionId !== m.id ||
    b.scope.cluster !== "mainnet-beta" ||
    b.scope.owner !== s.owner ||
    b.scope.pool !== s.pool ||
    b.scope.mintX !== s.mintX ||
    b.scope.mintY !== s.mintY ||
    b.policyDigest !== p.digest
  )
    throw new Error("The mission policy changed. Seal a matching budget and rebuild the review.");
  if (now >= p.policy.expiresAt) throw new Error("The mission policy expired.");
  if (b.expiresAt > p.policy.expiresAt)
    throw new Error("A budget cannot outlive its mission policy.");
  if (b.allowedActions.some((a) => !p.policy.allowedActions.includes(a)))
    throw new Error("Budget actions exceed the mission policy.");
}

export async function listLedger(missionId: string) {
  return ledgerTx<{ budgets: BudgetRow[]; operations: OperationRow[] }>(
    [BUDGETS, OPERATIONS],
    "readonly",
    (t, done, fail) => {
      all<BudgetRow>(t.objectStore(BUDGETS), missionId, (budgets) =>
        all<OperationRow>(t.objectStore(OPERATIONS), missionId, (operations) => {
          try {
            validRows(budgets, operations);
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
export async function sealBudget(
  budget: ExecutionBudget,
  expected: number | null,
  now = Date.now(),
) {
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
      if (
        s.pool !== b.scope.pool ||
        s.owner !== b.scope.owner ||
        s.mintX !== b.scope.mintX ||
        s.mintY !== b.scope.mintY ||
        b.scope.cluster !== "mainnet-beta"
      )
        return fail("Budget scope does not match the mission's pool, owner and mints.");
      if (p.digest !== b.policyDigest)
        return fail("Budget must bind the mission's latest sealed policy.");
      try {
        policyBinding(mission, b, now);
      } catch (e) {
        return fail((e as Error).message);
      }
      all<BudgetRow>(t.objectStore(BUDGETS), b.scope.missionId, (rows) => {
        const latest = latestOf(rows)?.budget.revision ?? null;
        if (latest !== expected || b.revision !== (latest ?? 0) + 1)
          return fail("The budget changed in another tab. Reload before sealing.");
        if (rows.length >= MAX_BUDGET_REVISIONS)
          return fail(
            `Budget history is full (${MAX_BUDGET_REVISIONS} revisions retained). No revision was sealed.`,
          );
        all<OperationRow>(t.objectStore(OPERATIONS), b.scope.missionId, (ops) => {
          try {
            validRows(rows, ops);
          } catch (e) {
            return fail((e as Error).message);
          }
          const tot = ledgerTotals(
            b.scope,
            ops.map((o) => o.op),
          );
          const below = (cap: string, a: string, r: string) => BigInt(cap) < BigInt(a) + BigInt(r);
          if (
            below(b.totalXRaw, tot.consumed.xRaw, tot.reserved.xRaw) ||
            below(b.totalYRaw, tot.consumed.yRaw, tot.reserved.yRaw) ||
            below(b.totalLamports, tot.consumed.lamports, tot.reserved.lamports)
          )
            return fail(
              "A new budget cannot be smaller than already consumed plus unresolved amounts.",
            );
          const add = t
            .objectStore(BUDGETS)
            .add({
              key: budgetKey(b.scope.missionId, b.revision),
              missionId: b.scope.missionId,
              sealedAt: now,
              budget: b,
            } satisfies BudgetRow);
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
  if (
    o.state !== "proposed" ||
    o.history.length !== 1 ||
    o.history[0]!.state !== "proposed" ||
    o.consumed ||
    o.signature ||
    o.blockhash ||
    o.messageHash ||
    o.lastValidBlockHeight !== null
  )
    throw new Error("New operations start as a clean proposal.");
  await ledgerTx<void>(["missions", BUDGETS, OPERATIONS], "readwrite", (t, done, fail) => {
    const s = t.objectStore(OPERATIONS);
    const m = t.objectStore("missions").get(o.scope.missionId);
    m.onsuccess = () => {
      let mission: ConductorMission;
      try {
        mission = ConductorMission.parse(m.result);
      } catch {
        return fail("This mission was removed or is invalid.");
      }
      all<BudgetRow>(t.objectStore(BUDGETS), o.scope.missionId, (budgets) => {
        const latest = latestOf(budgets);
        try {
          if (!latest) throw new Error("Seal an execution budget first.");
          policyBinding(mission, latest.budget, Date.now());
        } catch (e) {
          return fail((e as Error).message);
        }
        const r = s.getAll();
        r.onsuccess = () => {
          const allRows = r.result as OperationRow[];
          const rows = allRows.filter((r) => r.missionId === o.scope.missionId);
          try {
            validRows(budgets, allRows);
          } catch (e) {
            return fail((e as Error).message);
          }
          if (rows.some((r) => r.id === o.id)) return fail("Duplicate operation id.");
          if (
            allRows.some(
              (r) =>
                r.op.scope.owner === o.scope.owner &&
                r.op.scope.cluster === o.scope.cluster &&
                !TERMINAL.includes(r.op.state),
            )
          )
            return fail(
              "Another operation for this wallet is still active on this device. Resolve it first.",
            );
          if (rows.length >= MAX_OPERATIONS)
            return fail(
              `Operation history is full (${MAX_OPERATIONS} retained). Export and start a new mission; nothing was truncated.`,
            );
          const add = s.add({
            id: o.id,
            missionId: o.scope.missionId,
            row: 1,
            op: o,
          } satisfies OperationRow);
          add.onsuccess = () => done(undefined);
        };
      });
    };
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
  const result = await ledgerTx<OperationRow>(
    ["missions", BUDGETS, OPERATIONS],
    "readwrite",
    (t, done, fail) => {
      const s = t.objectStore(OPERATIONS),
        g = s.get(id);
      g.onsuccess = () => {
        const row = g.result as OperationRow | undefined;
        if (!row) return fail("Operation not found.");
        if (row.row !== expectedRow) return fail("Operation changed in another tab. Reload first.");
        all<BudgetRow>(t.objectStore(BUDGETS), row.missionId, (budgets) =>
          all<OperationRow>(s, row.missionId, (rows) => {
            const latest = latestOf(budgets);
            try {
              validRows(budgets, rows);
            } catch (e) {
              return fail((e as Error).message);
            }
            const finish = () => {
              if (next === "reserved" || next === "signed" || next === "submitted") {
                const others = rows.filter((r) => r.id !== id).map((r) => r.op);
                const check = checkReservation(
                  latest?.budget ?? null,
                  latest?.budget.revision ?? null,
                  row.op,
                  others,
                  now,
                );
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
            };
            if (["reserved", "signed", "submitted"].includes(next)) {
              const m = t.objectStore("missions").get(row.missionId);
              m.onsuccess = () => {
                try {
                  if (!latest) throw new Error("No execution budget is sealed.");
                  policyBinding(ConductorMission.parse(m.result), latest.budget, now);
                } catch (e) {
                  return fail((e as Error).message);
                }
                finish();
              };
            } else finish();
          }),
        );
      };
    },
  );
  notifyConductor();
  return result;
}

/** Fresh atomic read used by policy guards; no exported report can supply this state. */
export async function readExecutionState(missionId: string) {
  return ledgerTx<{ mission: ConductorMission; budgets: BudgetRow[]; operations: OperationRow[] }>(
    ["missions", BUDGETS, OPERATIONS],
    "readonly",
    (t, done, fail) => {
      const r = t.objectStore("missions").get(missionId);
      r.onsuccess = () => {
        let mission: ConductorMission;
        try {
          mission = ConductorMission.parse(r.result);
        } catch {
          return fail("Mission was removed or is invalid.");
        }
        all<BudgetRow>(t.objectStore(BUDGETS), missionId, (budgets) =>
          all<OperationRow>(t.objectStore(OPERATIONS), missionId, (operations) => {
            try {
              validRows(budgets, operations);
            } catch (e) {
              return fail((e as Error).message);
            }
            done({ mission, budgets, operations });
          }),
        );
      };
    },
  );
}

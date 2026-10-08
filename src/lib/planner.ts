/**
 * Rebalance Planner — pure rules (no SDK, no React).
 * Planning never moves funds. A selected plan is only a request to build a FRESH
 * review against current chain state; the review/runner guards still decide.
 */
import { balancedTarget, pairOrientation } from "./agents";
import { MAX_UI_BINS, type StrategyName } from "./strategy";

export const PLAN_OPTIONS = ["keep", "recenter", "widen", "move"] as const;
export type PlanOption = (typeof PLAN_OPTIONS)[number];
export const OPTION_LABEL: Record<PlanOption, string> = {
  keep: "Stay put",
  recenter: "Recenter, same width",
  widen: "Widen to a chosen range",
  move: "Move to another pool",
};

/** A planning snapshot older than this must be re-run before it can be selected. */
export const PLAN_SNAPSHOT_TTL_MS = 120_000;

/** Every input that, when changed, makes earlier plans and reviews meaningless. */
export interface PlanIdentity {
  mode: "wallet" | "watch" | "practice";
  owner: string;
  cluster: string;
  rpcId: string;
  position: string;
  pool: string;
  strategy: StrategyName;
  slippageBps: number;
  ruleRevision: number;
  watchRevision: number | null;
  widenLower: number | null;
  widenUpper: number | null;
  destPool: string | null;
}

export function planIdentityKey(i: PlanIdentity): string {
  const o = i as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k] ?? null]));
}

export interface Range { lower: number; upper: number }
export const widthOf = (r: Range) => r.upper - r.lower + 1;
export const covers = (r: Range, active: number) => active >= r.lower && active <= r.upper;

/** Explicit widen range: integers, strictly wider than the current width, within the tested UI cap. */
export function validateWiden(current: Range, lower: number | null, upper: number | null): { ok: true; range: Range } | { ok: false; error: string } {
  if (lower === null || upper === null || !Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) return { ok: false, error: "Enter whole-number lower and upper price levels." };
  if (lower > upper) return { ok: false, error: "Lower level must not be above the upper level." };
  const r = { lower, upper };
  if (widthOf(r) <= widthOf(current)) return { ok: false, error: `Widening needs more than the current ${widthOf(current)} levels.` };
  if (widthOf(r) > MAX_UI_BINS) return { ok: false, error: `Studio Loco plans at most ${MAX_UI_BINS} levels per position.` };
  return { ok: true, range: r };
}

/** Target range per option, from the snapshot's active bin. `null` = no change. */
export function targetFor(option: PlanOption, current: Range, activeId: number, widen?: Range, destActiveId?: number): Range | null {
  if (option === "keep") return null;
  if (option === "recenter") return balancedTarget(activeId, widthOf(current));
  if (option === "widen") { if (!widen) throw new Error("Choose a widen range first."); return widen; }
  if (destActiveId === undefined) throw new Error("Destination pool not loaded.");
  return balancedTarget(destActiveId, Math.min(widthOf(current), MAX_UI_BINS));
}

/** Maps source amounts (by mint ADDRESS) into a destination pool's X/Y slots. */
export function mapToDestination(src: { mintX: string; mintY: string; x: string; y: string }, dest: { mintX: string; mintY: string }): { x: string; y: string; orientation: "same" | "reversed" } {
  const o = pairOrientation(dest.mintX, dest.mintY, src.mintX, src.mintY);
  if (!o) throw new Error("Destination pool does not hold the same two mint addresses.");
  return o === "same" ? { x: src.x, y: src.y, orientation: o } : { x: src.y, y: src.x, orientation: o };
}

/** Exact decimal SOL text → lamports (bigint), no floats. */
export function solTextToLamports(t: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{0,9}))?$/.exec(t.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
}

/** SDK rent quotes are decimal SOL numbers; convert once, honestly rounded up. */
export function sdkSolToLamports(sol: number | null | undefined): bigint | null {
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol < 0) return null;
  return BigInt(Math.ceil(Number(sol.toFixed(9)) * 1e9));
}

export type Recovery =
  | { state: "none"; reason: string }
  | { state: "unavailable"; reason: string }
  | { state: "estimate"; days: string; assumptionLamportsPerDay: string; costLamports: string };

/**
 * Days to recover KNOWN SOL costs at a USER-ENTERED fee-income assumption.
 * Never forecasts fees; refuses when the cost or the assumption is missing.
 */
export function feeRecovery(option: PlanOption, costLamports: bigint | null, assumptionLamportsPerDay: bigint | null): Recovery {
  if (option === "keep") return { state: "none", reason: "Staying put sends no transaction, so there is no cost to recover." };
  if (costLamports === null) return { state: "unavailable", reason: "Some costs are unpriced until the fresh review, so no recovery estimate is shown." };
  if (assumptionLamportsPerDay === null || assumptionLamportsPerDay <= 0n) return { state: "unavailable", reason: "Enter your own daily fee-income assumption to see a recovery estimate." };
  const tenths = (costLamports * 10n + assumptionLamportsPerDay - 1n) / assumptionLamportsPerDay;
  return { state: "estimate", days: `${tenths / 10n}.${tenths % 10n}`, assumptionLamportsPerDay: assumptionLamportsPerDay.toString(), costLamports: costLamports.toString() };
}

export interface OptionResult {
  option: PlanOption;
  target: Range | null;
  /** "none" = no transaction; "sdk-ok" = SDK amount simulation succeeded; "failed"/"unsupported" carry reason. */
  sim: "none" | "sdk-ok" | "staged-verified" | "failed" | "unsupported";
  reason?: string;
  /** Raw integer strings in the SOURCE pool's X/Y (move: also destination mapping). */
  withdrawX?: string; withdrawY?: string;
  depositX?: string; depositY?: string;
  walletOutX?: string; walletOutY?: string;
  topUpX?: string; topUpY?: string;
  /** Known SDK rent quote in lamports, or null if unpriced. */
  rentLamports: bigint | null;
  destPool?: string;
  orientation?: "same" | "reversed";
  coversActive?: boolean;
}

export interface PlanSnapshot {
  id: string;
  identityKey: string;
  identity: PlanIdentity;
  createdAt: number;
  slot: number | null;
  activeId: number;
  current: Range;
  mintX: string; mintY: string; decX: number; decY: number;
  results: OptionResult[];
  assumptionLamportsPerDay: string | null;
}

/** Selection is allowed only for the live identity, fresh snapshot, a simulated option, in wallet mode. */
export function selectionRefusal(s: PlanSnapshot, liveKey: string, option: PlanOption, now: number): string | null {
  if (s.identityKey !== liveKey) return "Wallet, network, connection, range, slippage, position or watch changed. Re-run the comparison.";
  if (now - s.createdAt > PLAN_SNAPSHOT_TTL_MS) return "This comparison is older than 2 minutes. Re-run it.";
  if (s.identity.mode !== "wallet") return s.identity.mode === "watch" ? "Watch-only: compare freely, but wallet actions are off." : "Practice examples cannot be reviewed or signed.";
  const r = s.results.find((x) => x.option === option);
  if (!r) return "Option not in this comparison.";
  if (option === "keep") return "Staying put needs no transaction.";
  if (option === "move" ? r.sim !== "staged-verified" || !r.destPool : r.sim !== "sdk-ok") return r.reason ?? "This option did not simulate.";
  return null;
}

type Ctx = Record<string, string | number | boolean | null>;
const rpcKind = (id: string) => (id === "relay" ? "relay" : "custom");

/** Immutable comparison fact. Contains identifiers and raw amounts only — never RPC URLs, logs or bytes. */
export function comparisonFact(s: PlanSnapshot, route = "/app/agents") {
  const context: Ctx = {
    recordType: "rebalance-comparison", planId: s.id, mode: s.identity.mode, rpcKind: rpcKind(s.identity.rpcId),
    position: s.identity.position, pool: s.identity.pool, mintX: s.mintX, mintY: s.mintY,
    strategy: s.identity.strategy, slippageBps: s.identity.slippageBps, ruleRevision: s.identity.ruleRevision,
    watchRevision: s.identity.watchRevision, snapshotAt: s.createdAt, slot: s.slot, activeId: s.activeId,
    currentLower: s.current.lower, currentUpper: s.current.upper,
    feeAssumptionLamportsPerDay: s.assumptionLamportsPerDay, executable: false,
  };
  for (const r of s.results) {
    context[`${r.option}Sim`] = r.sim;
    context[`${r.option}Target`] = r.target ? `${r.target.lower}..${r.target.upper}` : null;
    if (r.depositX !== undefined) context[`${r.option}Deposit`] = `${r.depositX}/${r.depositY}`;
    context[`${r.option}RentLamports`] = r.rentLamports === null ? null : r.rentLamports.toString();
    if (r.destPool) context.moveDest = r.destPool;
    if (r.orientation) context.moveOrientation = r.orientation;
  }
  return {
    kind: "proposal" as const, status: "info" as const,
    title: `Rebalance comparison ${s.identity.position.slice(0, 6)}…`,
    route, cluster: s.identity.cluster, wallet: s.identity.owner,
    links: { proposalId: s.id },
    detail: `Planning snapshot only. ${s.results.length} options compared; nothing was signed.`,
    context,
  };
}

/** Immutable selection fact linking back to the comparison record. */
export function selectionFact(s: PlanSnapshot, option: PlanOption, comparisonRecordId: string, route = "/app/agents") {
  const r = s.results.find((x) => x.option === option);
  return {
    kind: "proposal" as const, status: "info" as const,
    title: `Plan selected: ${OPTION_LABEL[option]}`,
    route, cluster: s.identity.cluster, wallet: s.identity.owner,
    links: { proposalId: s.id, recordId: comparisonRecordId },
    detail: option === "keep" ? "Stay put selected — no transaction is needed." : "Selected for a fresh rebuilt review. Not executable from this record.",
    context: {
      recordType: "rebalance-selection", planId: s.id, option, position: s.identity.position, pool: s.identity.pool,
      target: r?.target ? `${r.target.lower}..${r.target.upper}` : null, destPool: r?.destPool ?? null,
      strategy: s.identity.strategy, slippageBps: s.identity.slippageBps, executable: false,
    } as Ctx,
  };
}

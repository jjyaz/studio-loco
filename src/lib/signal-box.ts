/**
 * Signal Box — hosted watch rules. Pure, deterministic evaluation shared by the scheduled
 * worker and tests. Observations and proposals only: nothing here builds, signs or sends.
 *
 * Position watches reuse the Observatory rule model (src/lib/agents.ts) unchanged, so hosted
 * and in-tab rules have identical precedence, cooldown and observed-time semantics.
 * Arb watches reuse Dispatch's validator and route verdicts (src/lib/arb-math.ts).
 */
import { z } from "zod";
import { RuleSchema, observeOut, observedMs, propose, type OutRun, type Proposal, type Rule, type VolReading } from "./agents";
import { validateConfig, type ArbConfig } from "./arb-math";
import { OrderWatchInput, type OrderBaseline } from "./journey-signals";

/** Scheduler cadence (pg_cron) — shown in the UI. */
export const TICK_MINUTES = 5;
/** Two missed ticks plus slack: a longer gap means we did not observe continuously, so out-duration resets. */
export const MAX_OBSERVATION_GAP_MS = 12 * 60_000;
/** Arb scans are heavy; each arb watch runs at most every 15 minutes. */
export const ARB_MIN_INTERVAL_MS = 14 * 60_000;
export const ARB_COOLDOWN_MS = 30 * 60_000;
export const WATCH_TTL_DAYS = 7;
export const MAX_WATCHES_PER_USER = 5;
export const MAX_ARB_WATCHES_PER_USER = 1;
export const MAX_WATCHES_PER_TICK = 20;
/** Observations older than this are "stale" in the UI. */
export const STALE_AFTER_MS = 3 * TICK_MINUTES * 60_000;

const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export const PositionWatchInput = z.object({
  kind: z.literal("position"),
  label: z.string().max(80).default(""),
  position: b58,
  pool: b58,
  owner: b58,
  rule: RuleSchema,
}).strict();

export const ArbWatchInput = z.object({
  kind: z.literal("arb"),
  label: z.string().max(80).default(""),
  config: z.unknown(),
}).strict();

export const WatchInput = z.discriminatedUnion("kind", [PositionWatchInput, ArbWatchInput, OrderWatchInput]);
export type WatchInput = z.infer<typeof WatchInput>;

/** The position-watch payload stored in `rule`: the Observatory rule plus verified mint identities. */
export const StoredPositionRule = z.object({ rule: RuleSchema, mintX: b58, mintY: b58, binStep: z.number().int().min(1).max(500) }).strict();
export type StoredPositionRule = z.infer<typeof StoredPositionRule>;

export function parseArbConfig(raw: unknown): { ok: true; cfg: ArbConfig } | { ok: false; error: string } {
  const v = validateConfig(raw);
  return v.ok ? { ok: true, cfg: v.cfg } : { ok: false, error: v.error };
}

/* ---------------- position tick ---------------- */

export interface PositionObservation {
  activeId: number;
  lower: number;
  upper: number;
  binStep: number;
  mintX: string;
  mintY: string;
  vol: VolReading | null;
}

export interface TickOutcome<T extends OutRun | OrderBaseline = OutRun> {
  ok: boolean;
  summary: Record<string, unknown>;
  error: string | null;
  outRun: T | null;
  lastProposed: Record<string, number>;
  alert: { trigger: string; reason: string; dedupe_key: string; payload: Record<string, unknown> } | null;
}

/** A failed read is an observation gap: out-duration resets and nothing is reported as calm. */
export function failedTick(error: string, lastProposed: Record<string, number>): TickOutcome {
  return { ok: false, summary: { state: "unavailable" }, error: error.slice(0, 300), outRun: null, lastProposed, alert: null };
}

export function positionTick(o: {
  watchId: string; revision: number; position: string; pool: string; owner: string;
  stored: StoredPositionRule; obs: PositionObservation; prevOut: OutRun | null; lastProposed: Record<string, number>; now: number;
}): TickOutcome {
  const { stored, obs, now } = o;
  if (obs.mintX !== stored.mintX || obs.mintY !== stored.mintY) return failedTick("Pool mint identity no longer matches the watched pair.", o.lastProposed);
  const rule: Rule = stored.rule;
  const isOut = obs.activeId < obs.lower || obs.activeId > obs.upper;
  const outRun = observeOut(o.prevOut ?? undefined, isOut, now, MAX_OBSERVATION_GAP_MS) ?? null;
  const pos = { key: o.position, pool: o.pool, activeId: obs.activeId, lower: obs.lower, upper: obs.upper, binStep: obs.binStep };
  const p: Proposal | null = propose({ rule, pos, outRun: outRun ?? undefined, vol: obs.vol, now }, o.lastProposed);
  const summary: Record<string, unknown> = {
    state: isOut ? "out-of-range" : "in-range", activeId: obs.activeId, lower: obs.lower, upper: obs.upper, binStep: obs.binStep,
    observedOutMin: outRun ? Math.floor(observedMs(outRun) / 60_000) : 0,
    vol: obs.vol ? (obs.vol.state === "ok" ? { state: "ok", pct: Number(obs.vol.pct.toFixed(4)) } : { state: "unavailable", reason: obs.vol.reason.slice(0, 160) }) : null,
    trigger: p?.trigger ?? null,
  };
  if (!p) return { ok: true, summary, error: null, outRun, lastProposed: o.lastProposed, alert: null };
  const lastProposed = { ...o.lastProposed, [p.id]: now };
  return {
    ok: true, summary, error: null, outRun, lastProposed,
    alert: {
      trigger: p.trigger, reason: p.reason,
      dedupe_key: `${o.watchId}:${p.id}:${Math.floor(now / (rule.cooldownMin * 60_000))}`,
      payload: { kind: p.kind, position: o.position, pool: o.pool, owner: o.owner, activeId: obs.activeId, withdrawPct: p.withdrawPct ?? null, target: p.target ?? null, ruleRevision: p.ruleRevision, observedAt: now },
    },
  };
}

/* ---------------- arb tick ---------------- */

export interface ArbRouteLite { poolA: string; poolB: string; nameA: string; nameB: string; verdict: "profitable" | "unprofitable" | "invalid"; expectedProfitLamports: string | null; reason?: string }

export function arbTick(o: { watchId: string; revision: number; routes: ArbRouteLite[]; complete: boolean; poolCount: number; inputSol: string; lastProposed: Record<string, number>; now: number }): TickOutcome {
  const profitable = o.routes.filter((r) => r.verdict === "profitable");
  const best = [...o.routes].filter((r) => r.expectedProfitLamports !== null).sort((a, b) => (BigInt(b.expectedProfitLamports!) > BigInt(a.expectedProfitLamports!) ? 1 : -1))[0];
  const summary: Record<string, unknown> = {
    routes: o.routes.length, profitable: profitable.length, complete: o.complete, pools: o.poolCount,
    bestExpectedProfitLamports: best?.expectedProfitLamports ?? null, best: best ? `${best.nameA} → ${best.nameB}` : null,
    evidence: o.complete ? "complete" : "partial — insufficient evidence for a no-opportunity conclusion",
  };
  const top = profitable[0];
  if (!top) return { ok: true, summary, error: null, outRun: null, lastProposed: o.lastProposed, alert: null };
  const id = `arb:${top.poolA}>${top.poolB}:r${o.revision}`;
  const last = o.lastProposed[id];
  if (last !== undefined && o.now - last < ARB_COOLDOWN_MS) return { ok: true, summary, error: null, outRun: null, lastProposed: o.lastProposed, alert: null };
  return {
    ok: true, summary, error: null, outRun: null, lastProposed: { ...o.lastProposed, [id]: o.now },
    alert: {
      trigger: "arb-floor-met",
      reason: `Read-only scan: ${top.nameA} → ${top.nameB} met the net-profit floor on ${o.inputSol} SOL using estimated costs. A fresh wallet-specific requote is required; it may no longer hold.`,
      dedupe_key: `${o.watchId}:${id}:${Math.floor(o.now / ARB_COOLDOWN_MS)}`,
      payload: { poolA: top.poolA, poolB: top.poolB, expectedProfitLamports: top.expectedProfitLamports, observedAt: o.now },
    },
  };
}

/* ---------------- health ---------------- */

export type WatchHealth = "healthy" | "stale" | "erroring" | "paused" | "expired" | "waiting";
export function watchHealth(w: { status: string; expires_at: string; last_ok_at: string | null; last_run_at: string | null; consecutive_errors: number; created_at: string }, now: number): WatchHealth {
  if (Date.parse(w.expires_at) < now) return "expired";
  if (w.status === "paused") return "paused";
  if (w.consecutive_errors >= 2) return "erroring";
  if (!w.last_run_at) return now - Date.parse(w.created_at) > STALE_AFTER_MS ? "stale" : "waiting";
  const ok = w.last_ok_at ? Date.parse(w.last_ok_at) : 0;
  return now - ok > STALE_AFTER_MS ? "stale" : "healthy";
}

/** Fresh-context handoff URL for an alert. Carries identifiers only — never a transaction. */
export function handoffFor(a: { id: string; watch_kind: string; payload: Record<string, unknown> }): { to: "/app/agents" | "/app/dispatch" | "/app/journey"; search: Record<string, string> } {
  if (a.watch_kind === "order") return { to: "/app/journey", search: { alert: a.id } };
  if (a.watch_kind === "arb") return { to: "/app/dispatch", search: { alert: a.id } };
  const p = a.payload;
  const s: Record<string, string> = { alert: a.id };
  if (typeof p["owner"] === "string") s["inspect"] = p["owner"];
  if (typeof p["position"] === "string") s["focus"] = p["position"];
  return { to: "/app/agents", search: s };
}

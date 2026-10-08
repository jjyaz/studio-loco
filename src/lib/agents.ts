/**
 * Liquidity Agents ("The Observatory") — pure, deterministic rule logic.
 * Observes positions, evaluates user-armed rules and produces PROPOSALS only.
 * Nothing here signs, sends or moves funds; every action goes through the shared runner after review.
 */
import { z } from "zod";
import type { StrategyName } from "./strategy";

/* ---------------- identity & scope ---------------- */

/** Non-reversible label for the RPC in use. Never the URL (custom URLs can embed API keys). */
export function rpcIdentity(customUrl: string | undefined | null): string {
  const u = (customUrl ?? "").trim();
  if (!u) return "relay";
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) { h ^= u.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `custom-${h.toString(16).padStart(8, "0")}`;
}

export type AgentMode = "wallet" | "watch" | "practice";

export function rulesStorageKey(owner: string, cluster: string, rpcId: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner) && !owner.startsWith("PRACTICE-")) throw new Error("Invalid owner for rule scope");
  if (!/^(relay|custom-[0-9a-f]{8}|practice)$/.test(rpcId)) throw new Error("Invalid RPC identity for rule scope");
  return `studio-loco:agent-rules:v1:${cluster}:${rpcId}:${owner}`;
}

/* ---------------- rules ---------------- */

export const VOL_FRAMES = ["5m", "1h"] as const;
export type VolFrame = (typeof VOL_FRAMES)[number];
export const FRAME_MS: Record<VolFrame, number> = { "5m": 300_000, "1h": 3_600_000 };
export const volatilityKey = (pool: string, frame: VolFrame, candles: number) => `${pool}:${frame}:${candles}`;

const Baseline = z.object({ activeId: z.number().int(), binStep: z.number().int().min(1).max(500), at: z.number().int().positive() }).strict();
const Vol = z.object({ frame: z.enum(VOL_FRAMES), candles: z.number().int().min(6).max(48), thresholdPct: z.number().min(0.05).max(50), withdrawPct: z.number().int().min(1).max(100) }).strict();

export const RuleSchema = z.object({
  v: z.literal(1),
  revision: z.number().int().min(0),
  armed: z.boolean(),
  baseline: Baseline.nullable(),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]),
  priceMovePct: z.number().min(0.1).max(100).nullable(),
  edgeBuffer: z.number().int().min(0).max(50).nullable(),
  rebalanceOnExit: z.boolean(),
  outMinutes: z.number().int().min(0).max(1440).nullable(),
  outWithdrawPct: z.number().int().min(1).max(100),
  volatility: Vol.nullable(),
  cooldownMin: z.number().int().min(1).max(1440),
}).strict().refine((r) => !r.armed || r.baseline !== null, { message: "An armed rule needs a baseline" });

export type Rule = z.infer<typeof RuleSchema>;

export const DEFAULT_RULE: Rule = {
  v: 1, revision: 0, armed: false, baseline: null, strategy: "Spot",
  priceMovePct: null, edgeBuffer: 3, rebalanceOnExit: true, outMinutes: null, outWithdrawPct: 50, volatility: null, cooldownMin: 10,
};

export type RuleParams = Omit<Rule, "v" | "revision" | "armed" | "baseline">;

/** Any parameter edit bumps the revision and disarms (old reviews become stale, baseline must be re-captured). */
export function editRule(r: Rule, patch: Partial<RuleParams>): Rule {
  const next = { ...r, ...patch, revision: r.revision + 1, armed: false, baseline: null };
  const ok = RuleSchema.safeParse(next);
  if (!ok.success) throw new Error(ok.error.issues[0]?.message ?? "Invalid rule");
  return ok.data;
}

/** Arming captures an explicit real baseline from a fresh on-chain read. */
export function armRule(r: Rule, activeId: number, binStep: number, now: number): Rule {
  if (!Number.isInteger(activeId) || !Number.isInteger(binStep) || binStep < 1) throw new Error("A real active bin and bin step are required to arm");
  return RuleSchema.parse({ ...r, armed: true, baseline: { activeId, binStep, at: now }, revision: r.revision + 1 });
}
export function disarmRule(r: Rule): Rule { return { ...r, armed: false, baseline: null, revision: r.revision + 1 }; }
/** Re-anchor only after a CONFIRMED rebalance. */
export function rebaseAfterConfirmedRebalance(r: Rule, activeId: number, binStep: number, now: number): Rule {
  return armRule(r, activeId, binStep, now);
}

export const RuleStoreSchema = z.object({ v: z.literal(1), rules: z.record(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$|^PRACTICE-/), z.unknown()) });
/** Parse a stored rule map; malformed entries are dropped, never repaired. */
export function parseRuleStore(raw: unknown): Record<string, Rule> {
  const s = RuleStoreSchema.safeParse(raw);
  if (!s.success) return {};
  const out: Record<string, Rule> = {};
  for (const [k, v] of Object.entries(s.data.rules)) { const r = RuleSchema.safeParse(v); if (r.success) out[k] = r.data; }
  return out;
}

/* ---------------- plain-language rule assistant (deterministic grammar) ---------------- */

export const SUPPORTED_COMMANDS = [
  "review my range after a 5% price move",
  "alert me within 3 bins of the edge",
  "rebalance when out of range",
  "prepare a 50% withdrawal after 15 minutes out of range",
  "prepare a 25% withdrawal if 5m volatility over 12 candles exceeds 1.5%",
  "use curve distribution",
  "cooldown 30 minutes",
];

export type ParseResult = { ok: true; patch: Partial<RuleParams>; summary: string[] } | { ok: false; error: string };

const num = (s: string) => Number(s);
function inRange(n: number, lo: number, hi: number, what: string, int = false): string | null {
  if (!Number.isFinite(n)) return `${what} is not a number`;
  if (int && !Number.isInteger(n)) return `${what} must be a whole number`;
  if (n < lo || n > hi) return `${what} must be between ${lo} and ${hi}`;
  return null;
}

/** Parses one or more clauses separated by ";" or new lines. Unknown or ambiguous clauses fail the whole command. */
export function parseCommand(input: string): ParseResult {
  const clauses = input.toLowerCase().split(/[;\n]+/).map((c) => c.trim().replace(/\s+/g, " ").replace(/[.!]$/, "")).filter(Boolean);
  if (!clauses.length) return { ok: false, error: "Type a rule, for example: “review my range after a 5% price move”." };
  if (clauses.length > 6) return { ok: false, error: "At most 6 clauses at a time." };
  const patch: Partial<RuleParams> = {};
  const summary: string[] = [];
  const seen = new Set<string>();
  const set = <K extends keyof RuleParams>(k: K, v: RuleParams[K]) => {
    if (seen.has(k)) throw new Error(`“${k}” is set twice — the command is ambiguous.`);
    seen.add(k); patch[k] = v;
  };
  try {
    for (const c of clauses) {
      let m: RegExpMatchArray | null;
      if ((m = c.match(/^(?:review|rebalance) my range (?:after|on) an? (\d+(?:\.\d+)?)% price (?:move|change)$/))) {
        const n = num(m[1]!); const e = inRange(n, 0.1, 100, "Price move"); if (e) throw new Error(e);
        set("priceMovePct", n); summary.push(`Propose a rebalance when price moves ${n}% from the armed baseline.`);
      } else if ((m = c.match(/^alert me within (\d+) bins? of (?:the|either) edge$/))) {
        const n = num(m[1]!); const e = inRange(n, 0, 50, "Edge buffer", true); if (e) throw new Error(e);
        set("edgeBuffer", n); summary.push(`Flag the position within ${n} bins of either range edge.`);
      } else if (/^(?:rebalance|review my range) when (?:it )?(?:is |goes |leaves )?(?:out of range|range)$/.test(c)) {
        set("rebalanceOnExit", true); summary.push("Propose a rebalance when the active bin leaves the range.");
      } else if ((m = c.match(/^prepare an? (\d+)% withdrawal after (\d+) minutes? out of range$/))) {
        const p = num(m[1]!), t = num(m[2]!);
        const e = inRange(p, 1, 100, "Withdrawal", true) ?? inRange(t, 0, 1440, "Minutes", true); if (e) throw new Error(e);
        set("outWithdrawPct", p); set("outMinutes", t); summary.push(`Prepare a ${p}% withdrawal after ${t} observed minutes out of range.`);
      } else if ((m = c.match(/^prepare an? (\d+)% withdrawal if (5m|1h) volatility over (\d+) candles exceeds (\d+(?:\.\d+)?)%$/))) {
        const p = num(m[1]!), n = num(m[3]!), v = num(m[4]!);
        const e = inRange(p, 1, 100, "Withdrawal", true) ?? inRange(n, 6, 48, "Candle count", true) ?? inRange(v, 0.05, 50, "Volatility threshold"); if (e) throw new Error(e);
        set("volatility", { frame: m[2] as VolFrame, candles: n, thresholdPct: v, withdrawPct: p });
        summary.push(`Prepare a ${p}% withdrawal when the standard deviation of ${m[2]} close-to-close returns over the last ${n} candles exceeds ${v}%.`);
      } else if ((m = c.match(/^use (spot|curve|bid ?ask) (?:distribution|strategy|shape)$/))) {
        const s: StrategyName = m[1] === "spot" ? "Spot" : m[1] === "curve" ? "Curve" : "BidAsk";
        set("strategy", s); summary.push(`Rebalance with the ${s} distribution.`);
      } else if ((m = c.match(/^cooldown (\d+) minutes?$/))) {
        const n = num(m[1]!); const e = inRange(n, 1, 1440, "Cooldown", true); if (e) throw new Error(e);
        set("cooldownMin", n); summary.push(`Wait ${n} minutes before repeating the same proposal.`);
      } else {
        throw new Error(`I don't recognise “${c}”. Nothing was changed. Try one of the supported commands below.`);
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, patch, summary };
}

/* ---------------- price / bin math ---------------- */

/** Percentage price change implied by moving from bin a to bin b at a given bin step (bps). */
export function pctMoveBetweenBins(fromBin: number, toBin: number, binStep: number): number {
  return (Math.pow(1 + binStep / 10_000, toBin - fromBin) - 1) * 100;
}
/** Smallest bin distance whose price change is at least pct% (either direction). */
export function binsForPctMove(pct: number, binStep: number): number {
  if (!(pct > 0) || !(binStep > 0)) throw new Error("pct and binStep must be positive");
  return Math.ceil(Math.log(1 + pct / 100) / Math.log(1 + binStep / 10_000) - 1e-12);
}

/** Conservative bin limit: the upward price change may not exceed the user's slippage. */
export function activeBinSlippage(slippageBps: number, binStep: number): number {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000 || !Number.isInteger(binStep) || binStep < 1) throw new Error("Invalid slippage or bin step.");
  return Math.max(0, Math.floor(Math.log1p(slippageBps / 10_000) / Math.log1p(binStep / 10_000) + 1e-12));
}

/** Exact-width target around the active bin; even ranges have one more bin on the bid side. */
export function balancedTarget(activeId: number, width: number): { lower: number; upper: number } {
  if (!Number.isSafeInteger(activeId) || !Number.isSafeInteger(width) || width < 1) throw new Error("Invalid bin target");
  const lower = activeId - Math.floor(width / 2);
  const upper = lower + width - 1;
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) throw new Error("Invalid bin target");
  return { lower, upper };
}

/* ---------------- observed-time continuity ---------------- */

export interface OutRun { startedAt: number; lastSeen: number }
/** Elapsed out-of-range time counts only across observations no further apart than maxGapMs. */
export function observeOut(run: OutRun | undefined, isOut: boolean, now: number, maxGapMs: number): OutRun | undefined {
  if (!isOut) return undefined;
  if (run && now >= run.lastSeen && now - run.lastSeen <= maxGapMs) return { startedAt: run.startedAt, lastSeen: now };
  return { startedAt: now, lastSeen: now };
}
export const observedMs = (run: OutRun | undefined) => (run ? run.lastSeen - run.startedAt : 0);

/* ---------------- volatility ---------------- */

export interface CandleLite { t: number; c: number }
export type VolReading = { state: "ok"; pct: number; candles: number; newestAt: number } | { state: "unavailable"; reason: string };

/** Std-dev of close-to-close log returns over the last n candles, in %. Missing/stale data is UNAVAILABLE, never low. */
export function volatility(candles: CandleLite[], n: number, frame: VolFrame, now: number): VolReading {
  const ok = candles.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c) && k.c > 0).sort((a, b) => a.t - b.t);
  if (ok.length < n + 1) return { state: "unavailable", reason: `Only ${ok.length} usable candles; ${n + 1} needed.` };
  const last = ok.slice(-(n + 1));
  const newestMs = last[last.length - 1]!.t * (last[last.length - 1]!.t < 1e12 ? 1000 : 1);
  if (newestMs > now) return { state: "unavailable", reason: "Price history contains a future candle." };
  if (now - newestMs > 2 * FRAME_MS[frame]) return { state: "unavailable", reason: "Newest candle is stale." };
  const rets: number[] = [];
  for (let i = 1; i < last.length; i++) {
    const ms = (k: CandleLite) => k.t * (k.t < 1e12 ? 1000 : 1);
    const gap = ms(last[i]!) - ms(last[i - 1]!);
    if (Math.abs(gap - FRAME_MS[frame]) > 1000) return { state: "unavailable", reason: "Price history has duplicate or missing candles." };
    rets.push(Math.log(last[i]!.c / last[i - 1]!.c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return { state: "ok", pct: sd * 100, candles: n, newestAt: newestMs };
}

/* ---------------- triggers & proposals ---------------- */

export type TriggerKind = "out-time" | "volatility" | "left-range" | "price-move" | "edge";
/** Lower index wins. Risk exits outrank rebalances. */
export const PRECEDENCE: TriggerKind[] = ["out-time", "volatility", "left-range", "price-move", "edge"];

export interface PositionView { key: string; pool: string; activeId: number; lower: number; upper: number; binStep: number }

export interface Proposal {
  id: string;
  position: string;
  pool: string;
  kind: "rebalance" | "reduce";
  trigger: TriggerKind | "planner";
  reason: string;
  withdrawPct?: number;
  target?: { lower: number; upper: number };
  ruleRevision: number;
  createdAt: number;
}

export interface EvalInput {
  rule: Rule;
  pos: PositionView;
  outRun: OutRun | undefined;
  vol: VolReading | null;
  now: number;
}
export interface EvalOutput { triggers: { kind: TriggerKind; reason: string }[]; volUnknown: string | null }

export function evaluate(i: EvalInput): EvalOutput {
  const { rule, pos } = i;
  const t: { kind: TriggerKind; reason: string }[] = [];
  let volUnknown: string | null = null;
  if (!rule.armed || !rule.baseline) return { triggers: [], volUnknown };
  const out = pos.activeId < pos.lower || pos.activeId > pos.upper;
  if (out && rule.outMinutes !== null) {
    const ms = observedMs(i.outRun);
    if (ms >= rule.outMinutes * 60_000) t.push({ kind: "out-time", reason: `Observed out of range for ${Math.floor(ms / 60_000)} min while monitoring (threshold ${rule.outMinutes} min).` });
  }
  if (rule.volatility) {
    if (!i.vol || i.vol.state === "unavailable") volUnknown = i.vol?.state === "unavailable" ? i.vol.reason : "No volatility reading yet.";
    else if (i.vol.pct > rule.volatility.thresholdPct) t.push({ kind: "volatility", reason: `${rule.volatility.frame} volatility ${i.vol.pct.toFixed(3)}% over ${i.vol.candles} candles exceeds ${rule.volatility.thresholdPct}%.` });
  }
  if (out && rule.rebalanceOnExit) t.push({ kind: "left-range", reason: `Active bin ${pos.activeId} is outside the range ${pos.lower}–${pos.upper}.` });
  if (rule.priceMovePct !== null && rule.baseline.binStep === pos.binStep) {
    const mv = pctMoveBetweenBins(rule.baseline.activeId, pos.activeId, pos.binStep);
    if (Math.abs(mv) >= rule.priceMovePct) t.push({ kind: "price-move", reason: `Price moved ${mv.toFixed(2)}% from the baseline bin ${rule.baseline.activeId} (threshold ${rule.priceMovePct}%).` });
  }
  if (!out && rule.edgeBuffer !== null) {
    const d = Math.min(pos.activeId - pos.lower, pos.upper - pos.activeId);
    if (d < rule.edgeBuffer) t.push({ kind: "edge", reason: `Active bin is ${d} bin(s) from the edge (buffer ${rule.edgeBuffer}).` });
  }
  t.sort((a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind));
  return { triggers: t, volUnknown };
}

export const proposalKey = (position: string, trigger: TriggerKind, revision: number) => `${position}:${trigger}:r${revision}`;

/** The highest active trigger owns the decision, including during its cooldown. */
export function propose(i: EvalInput, lastProposedAt: Record<string, number>): Proposal | null {
  const tr = evaluate(i).triggers[0];
  if (tr) {
    const id = proposalKey(i.pos.key, tr.kind, i.rule.revision);
    const last = lastProposedAt[id];
    if (last !== undefined && i.now - last < i.rule.cooldownMin * 60_000) return null;
    const reduce = tr.kind === "out-time" || tr.kind === "volatility";
    const width = i.pos.upper - i.pos.lower + 1;
    return {
      id, position: i.pos.key, pool: i.pos.pool, kind: reduce ? "reduce" : "rebalance", trigger: tr.kind, reason: tr.reason,
      withdrawPct: reduce ? (tr.kind === "out-time" ? i.rule.outWithdrawPct : i.rule.volatility!.withdrawPct) : undefined,
      target: reduce ? undefined : balancedTarget(i.pos.activeId, width),
      ruleRevision: i.rule.revision, createdAt: i.now,
    };
  }
  return null;
}

/** A queued decision is valid only for this revision and the current highest trigger. */
export function proposalIsCurrent(p: Proposal, i: EvalInput): boolean {
  return p.position === i.pos.key && p.pool === i.pos.pool && p.ruleRevision === i.rule.revision && evaluate(i).triggers[0]?.kind === p.trigger;
}

/* ---------------- capital allocation ---------------- */

export interface BinLite { binId: number; positionXAmount: string; positionYAmount: string }
export interface Allocation { totalX: bigint; totalY: bigint; activeX: bigint; activeY: bigint; outsideX: bigint; outsideY: bigint; binsWithLiquidity: number; binsTotal: number }

const INT = /^\d+$/;
/** Integer-exact. Returns null if any bin amount is malformed (shown as unavailable, never zero). */
export function allocation(bins: BinLite[] | undefined | null, activeId: number): Allocation | null {
  if (!bins || !Array.isArray(bins)) return null;
  const a: Allocation = { totalX: 0n, totalY: 0n, activeX: 0n, activeY: 0n, outsideX: 0n, outsideY: 0n, binsWithLiquidity: 0, binsTotal: bins.length };
  for (const b of bins) {
    const xs = String(b.positionXAmount).split(".")[0]!, ys = String(b.positionYAmount).split(".")[0]!;
    if (!INT.test(xs) || !INT.test(ys) || !Number.isInteger(b.binId)) return null;
    const x = BigInt(xs), y = BigInt(ys);
    a.totalX += x; a.totalY += y;
    if (x > 0n || y > 0n) a.binsWithLiquidity++;
    if (b.binId === activeId) { a.activeX += x; a.activeY += y; } else { a.outsideX += x; a.outsideY += y; }
  }
  return a;
}

/* ---------------- exact pair matching ---------------- */

export function pairOrientation(poolX: string, poolY: string, mintX: string, mintY: string): "same" | "reversed" | null {
  if (poolX === mintX && poolY === mintY) return "same";
  if (poolX === mintY && poolY === mintX) return "reversed";
  return null;
}

/* ---------------- spend gating & review freshness ---------------- */

export function spendRefusal(o: { mode: AgentMode; practiceSetting: boolean; canSign: boolean }): string | null {
  if (o.mode === "practice") return "Practice scenario — nothing here can be signed or sent.";
  if (o.mode === "watch") return "Watch-only mode inspects a public address and can never transact.";
  if (o.practiceSetting) return "Practice mode is on in Settings, which disables every live spending path.";
  if (!o.canSign) return "Connect a wallet that supports transaction signing.";
  return null;
}

export const REVIEW_TTL_MS = 20_000;

export interface FrozenReview {
  ruleRevision: number; wallet: string; cluster: string; rpcId: string; pool: string; position: string;
  action: "rebalance" | "withdraw"; targetLower?: number; targetUpper?: number; withdrawBps?: number;
  slippageBps: number; feeLamports: number | null; solOutLamports: number | null; builtAt: number; gen: number;
}
export interface LiveIdentity { ruleRevision: number | undefined; wallet: string; cluster: string; rpcId: string; practiceSetting: boolean; mode: AgentMode; slippageBps: number; gen: number; positionPresent: boolean }

export function reviewStaleReason(f: FrozenReview, l: LiveIdentity, now: number): string | null {
  if (l.mode !== "wallet") return "Not in wallet mode.";
  if (l.practiceSetting) return "Practice mode was turned on.";
  if (l.gen !== f.gen) return "Something changed since this review was built.";
  if (l.wallet !== f.wallet) return "The connected wallet changed.";
  if (l.cluster !== f.cluster || l.rpcId !== f.rpcId) return "The network or RPC changed.";
  if (!l.positionPresent) return "The position is no longer in the verified list.";
  if (l.ruleRevision !== f.ruleRevision) return "The rule was edited.";
  if (l.slippageBps !== f.slippageBps) return "Slippage changed.";
  if (!knownLamports(f.feeLamports) || !knownLamports(f.solOutLamports)) return "Costs are unknown or invalid, so this cannot be signed.";
  if (!Number.isFinite(f.builtAt) || now < f.builtAt || now - f.builtAt > REVIEW_TTL_MS) return "This review expired. Rebuild it from fresh chain state.";
  return null;
}

/** Fee-cap applied by the runner: reviewed fee per transaction must not grow. */
export function feeCap(f: FrozenReview): number | undefined { return f.feeLamports ?? undefined; }

export const knownLamports = (n: number | null | undefined): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Decimal SDK rent quotes are display estimates; conversion never passes a float to BigInt. */
export function solQuoteLamports(sol: number): number | null {
  if (!Number.isFinite(sol) || sol < 0) return null;
  const n = Math.round(sol * 1e9);
  return knownLamports(n) ? n : null;
}

export interface ExecutionCosts {
  perTxFee: (number | null)[]; solOutLamports: number | null; requiredLamports: number | null;
  walletLamports: number | null; sizes: number[]; units: (number | null)[]; simErrors: (string | null)[];
}

/** Used by both the button and the runner's guard; UI state alone never authorizes a signature. */
export function executionReadiness(c: ExecutionCosts, unresolved = false): string | null {
  if (unresolved) return "A previous transaction's settlement is unresolved. Check its status first.";
  if (c.simErrors[0]) return `Simulation failed: ${c.simErrors[0]}`;
  if (c.simErrors.length !== 1 || c.simErrors[0] !== null) return "Exact simulation is unavailable.";
  if (!knownLamports(c.perTxFee[0]) || !knownLamports(c.solOutLamports) || !knownLamports(c.requiredLamports)) return "Costs unknown or invalid — cannot sign.";
  if (!knownLamports(c.walletLamports)) return "Wallet SOL balance is unknown — cannot sign.";
  if (!Number.isSafeInteger(c.sizes[0]) || c.sizes[0]! < 1 || c.sizes[0]! > 1232) return "Transaction size is invalid.";
  if (!Number.isSafeInteger(c.units[0]) || c.units[0]! < 1 || c.units[0]! > 1_400_000) return "Simulation compute usage is unavailable or invalid.";
  if (c.requiredLamports < Math.max(c.perTxFee[0], c.solOutLamports)) return "Cost review is inconsistent.";
  if (c.walletLamports < c.requiredLamports) return "Wallet SOL is below the reviewed requirement.";
  return null;
}

/** Pending signatures survive navigation/reload; an RPC change cannot release the lock. */
export function unresolvedForOwner<T extends { wallet: string; cluster: string }>(pending: T[], wallet: string, cluster: string): T | null {
  return pending.find((p) => p.wallet === wallet && p.cluster === cluster) ?? null;
}

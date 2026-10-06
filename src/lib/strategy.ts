import { z } from "zod";
import bs58 from "bs58";

export type StrategyName = "Spot" | "Curve" | "BidAsk";
export const STRATEGIES: StrategyName[] = ["Spot", "Curve", "BidAsk"];

/** Maps to the SDK's StrategyType enum values (Spot=0, Curve=1, BidAsk=2). */
export const STRATEGY_TYPE_VALUE: Record<StrategyName, 0 | 1 | 2> = { Spot: 0, Curve: 1, BidAsk: 2 };

export interface BinWeight {
  binId: number;
  /** share of total X budget placed here (0..1) */
  x: number;
  /** share of total Y budget placed here (0..1) */
  y: number;
}

/** Raw shape weight for a bin at distance d from active, half-width w. */
function shapeWeight(strategy: StrategyName, d: number, w: number): number {
  const width = Math.max(1, w);
  if (strategy === "Spot") return 1;
  if (strategy === "Curve") {
    const sigma = width / 2.2;
    return Math.exp(-(d * d) / (2 * sigma * sigma));
  }
  // BidAsk: grows away from the active bin
  return 0.15 + Math.abs(d) / width;
}

/**
 * Illustrative normalized distribution — a SIMULATION of strategy shape.
 * DLMM convention: bins above active hold X, bins below hold Y, active may hold both.
 * The SDK computes the exact onchain amounts at transaction time.
 */
export function distribute(
  strategy: StrategyName,
  activeBin: number,
  minBin: number,
  maxBin: number,
): BinWeight[] {
  if (!Number.isInteger(minBin) || !Number.isInteger(maxBin) || minBin > maxBin) return [];
  const halfWidth = Math.max(activeBin - minBin, maxBin - activeBin, 1);
  const rows: { binId: number; wx: number; wy: number }[] = [];
  for (let b = minBin; b <= maxBin; b++) {
    const w = shapeWeight(strategy, b - activeBin, halfWidth);
    const holdsX = b >= activeBin;
    const holdsY = b <= activeBin;
    const share = b === activeBin ? 0.5 : 1;
    rows.push({ binId: b, wx: holdsX ? w * share : 0, wy: holdsY ? w * share : 0 });
  }
  const sx = rows.reduce((a, r) => a + r.wx, 0);
  const sy = rows.reduce((a, r) => a + r.wy, 0);
  return rows.map((r) => ({ binId: r.binId, x: sx > 0 ? r.wx / sx : 0, y: sy > 0 ? r.wy / sy : 0 }));
}

export function coversActive(activeBin: number, minBin: number, maxBin: number): boolean {
  return activeBin >= minBin && activeBin <= maxBin;
}

/** Tested UI cap for a single new position. The program supports wider dynamic positions; we keep a conservative cap. */
export const MAX_UI_BINS = 69;

export interface Template {
  id: "local" | "express" | "switchback";
  name: string;
  strategy: StrategyName;
  below: number;
  above: number;
  blurb: string;
}

export const TEMPLATES: Template[] = [
  { id: "local", name: "Local", strategy: "Spot", below: 34, above: 34, blurb: "Wide, even Spot coverage. Stops at every station." },
  { id: "express", name: "Express", strategy: "Curve", below: 8, above: 8, blurb: "Narrow Curve concentrated around the active bin." },
  { id: "switchback", name: "Switchback", strategy: "BidAsk", below: 20, above: 20, blurb: "BidAsk weight that grows toward the range edges." },
];

/* ---------- Saved routes (versioned JSON) ---------- */

/** Real Solana public key check: base58 that decodes to exactly 32 bytes. */
export function isPublicKey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export const DECIMAL_TEXT = /^(?:\d{1,20})(?:\.\d{1,18})?$/;
const pubkey = z.string().refine(isPublicKey, "Invalid Solana address");
const finite = (max: number) => z.number().finite().min(0).max(max);
const bins = z.number().int().min(0).max(MAX_UI_BINS - 1);
const decimalText = z.string().max(40).refine((v) => v === "" || DECIMAL_TEXT.test(v), "Amount must be plain decimal text");

const RouteV1 = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  pool: pubkey,
  poolName: z.string().max(60).optional(),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]),
  below: bins,
  above: bins,
  budget: finite(1e15),
  xShare: finite(1),
  createdAt: z.number().int().nonnegative(),
});

export const RouteSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(60),
    /** null = migrated from v1 without cluster identity; must be assigned before execution */
    cluster: z.enum(["mainnet-beta", "devnet"]).nullable(),
    pool: pubkey,
    poolName: z.string().max(60).optional(),
    strategy: z.enum(["Spot", "Curve", "BidAsk"]),
    below: bins,
    above: bins,
    /** execution-ready exact decimal token amounts (bound to the pool's mints at review time) */
    exec: z.object({ x: decimalText, y: decimalText, symX: z.string().max(20).optional(), symY: z.string().max(20).optional(), decX: z.number().int().min(0).max(18).optional(), decY: z.number().int().min(0).max(18).optional() }),
    /** illustrative only: never converted into token amounts */
    illustrative: z.object({ budget: finite(1e15), xShare: finite(1) }),
    createdAt: z.number().int().nonnegative(),
  })
  .refine((r) => r.below + r.above + 1 <= MAX_UI_BINS, { message: `Route exceeds ${MAX_UI_BINS} bins` });
export type SavedRoute = z.infer<typeof RouteSchema>;

export function migrateV1(r: z.infer<typeof RouteV1>): SavedRoute {
  return { id: r.id, name: r.name, cluster: null, pool: r.pool, poolName: r.poolName, strategy: r.strategy, below: r.below, above: r.above, exec: { x: "", y: "" }, illustrative: { budget: r.budget, xShare: r.xShare }, createdAt: r.createdAt };
}

const FileV1 = z.object({ kind: z.literal("studio-loco/routes"), version: z.literal(1), routes: z.array(z.unknown()).max(200) });
const FileV2 = z.object({ kind: z.literal("studio-loco/routes"), version: z.literal(2), routes: z.array(z.unknown()).max(200) });

export function exportRoutes(routes: SavedRoute[]): string {
  return JSON.stringify({ kind: "studio-loco/routes", version: 2, routes }, null, 2);
}

/** Validate one route of either version. Width is checked before schema bounds so the message is specific. */
export function parseRoute(raw: unknown, version: 1 | 2): { ok: true; route: SavedRoute; migrated: boolean } | { ok: false; error: string } {
  const w = raw as { below?: unknown; above?: unknown; name?: unknown };
  if (typeof w?.below === "number" && typeof w?.above === "number" && w.below + w.above + 1 > MAX_UI_BINS) {
    return { ok: false, error: `Route "${String(w.name ?? "?")}" exceeds ${MAX_UI_BINS} bins` };
  }
  if (version === 1) {
    const r = RouteV1.safeParse(raw);
    return r.success ? { ok: true, route: migrateV1(r.data), migrated: true } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid route" };
  }
  const r = RouteSchema.safeParse(raw);
  return r.success ? { ok: true, route: r.data, migrated: false } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid route" };
}

export function importRoutes(text: string): { ok: true; routes: SavedRoute[]; migrated: number } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  const v2 = FileV2.safeParse(parsed);
  const v1 = v2.success ? null : FileV1.safeParse(parsed);
  if (!v2.success && !v1?.success) return { ok: false, error: "Not a Studio Loco route file (kind/version 1 or 2 expected)" };
  const version = v2.success ? 2 : 1;
  const list = v2.success ? v2.data.routes : v1!.data!.routes;
  const out: SavedRoute[] = [];
  let migrated = 0;
  for (const raw of list) {
    const r = parseRoute(raw, version);
    if (!r.ok) return r;
    if (r.migrated) migrated++;
    out.push(r.route);
  }
  return { ok: true, routes: out, migrated };
}

/** Local storage loader: accepts stored v1 or v2 arrays, drops invalid entries. */
export function loadStoredRoutes(raw: unknown): SavedRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedRoute[] = [];
  for (const r of raw.slice(0, 200)) {
    const v = parseRoute(r, (r as { illustrative?: unknown })?.illustrative ? 2 : 1);
    if (v.ok) out.push(v.route);
  }
  return out;
}

export function encodeShare(route: SavedRoute): string {
  const json = JSON.stringify({ v: 2, r: route });
  const b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShare(s: string): SavedRoute | null {
  try {
    if (s.length > 4000) return null;
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, "base64").toString();
    const obj = JSON.parse(json) as { v?: number; r?: unknown };
    const r = obj && obj.v === 2 ? parseRoute(obj.r, 2) : parseRoute(obj, 1);
    return r.ok ? r.route : null;
  } catch {
    return null;
  }
}

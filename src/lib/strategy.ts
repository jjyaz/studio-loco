import { z } from "zod";

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

export const RouteSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  pool: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid pool address"),
  poolName: z.string().max(60).optional(),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]),
  below: z.number().int().min(0).max(MAX_UI_BINS),
  above: z.number().int().min(0).max(MAX_UI_BINS),
  budget: z.number().nonnegative().max(1e15),
  xShare: z.number().min(0).max(1),
  createdAt: z.number().int(),
});
export type SavedRoute = z.infer<typeof RouteSchema>;

export const RouteFileSchema = z.object({
  kind: z.literal("studio-loco/routes"),
  version: z.literal(1),
  routes: z.array(RouteSchema).max(200),
});

export function exportRoutes(routes: SavedRoute[]): string {
  return JSON.stringify({ kind: "studio-loco/routes", version: 1, routes }, null, 2);
}

export function importRoutes(text: string): { ok: true; routes: SavedRoute[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON" };
  }
  const res = RouteFileSchema.safeParse(parsed);
  if (!res.success) return { ok: false, error: res.error.issues[0]?.message ?? "Invalid route file" };
  const width = res.data.routes.find((r) => r.below + r.above + 1 > MAX_UI_BINS);
  if (width) return { ok: false, error: `Route "${width.name}" exceeds ${MAX_UI_BINS} bins` };
  return { ok: true, routes: res.data.routes };
}

export function encodeShare(route: SavedRoute): string {
  const json = JSON.stringify(route);
  const b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShare(s: string): SavedRoute | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, "base64").toString();
    const r = RouteSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

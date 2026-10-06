/**
 * LIVE data service: Meteora public DLMM data API (mainnet only).
 * https://docs.meteora.ag/api-reference/dlmm/pools/pools
 * No fallback to fake data: failures surface as typed errors.
 */
export const METEORA_API = "https://dlmm.datapi.meteora.ag";

export interface ApiToken {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  is_verified?: boolean;
  price?: number;
}

export interface ApiPool {
  address: string;
  name?: string;
  token_x: ApiToken;
  token_y: ApiToken;
  tvl?: number;
  current_price?: number;
  volume?: Record<string, number>;
  fees?: Record<string, number>;
  fee_tvl_ratio?: Record<string, number>;
  pool_config?: { bin_step?: number; base_fee_pct?: number; max_fee_pct?: number; protocol_fee_pct?: number };
  dynamic_fee_pct?: number;
  is_blacklisted?: boolean;
  has_farm?: boolean;
  created_at?: number;
  token_x_amount?: number;
  token_y_amount?: number;
  tags?: string[];
  launchpad?: string;
}

export interface PoolPage {
  data: ApiPool[];
  current_page: number;
  page_size: number;
  pages: number;
  total: number;
}

/** Verified live against /pools sort_by on 2026-10-06 (fees_24h is rejected by the API). */
export const SORT_KEYS = ["tvl", "volume_24h", "fee_24h", "fee_tvl_ratio_24h", "bin_step"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_LABELS: Record<SortKey, string> = {
  tvl: "TVL",
  volume_24h: "Volume 24h",
  fee_24h: "Fees 24h",
  fee_tvl_ratio_24h: "Fee / TVL 24h (%)",
  bin_step: "Bin step",
};

export class ApiError extends Error {
  constructor(
    message: string,
    public kind: "timeout" | "rate-limit" | "http" | "network" | "parse" | "aborted",
    public status?: number,
  ) {
    super(message);
  }
}

/** Upper bound for any server-requested wait (Retry-After). */
export const MAX_RETRY_WAIT_MS = 10_000;

/** Abort-aware sleep: rejects with an "aborted" ApiError as soon as the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new ApiError("Request cancelled", "aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", on); res(); }, ms);
    const on = () => { clearTimeout(t); rej(new ApiError("Request cancelled", "aborted")); };
    signal?.addEventListener("abort", on, { once: true });
  });
}

/** Parse Retry-After (seconds or HTTP date) and clamp to [0, MAX_RETRY_WAIT_MS]. */
export function retryAfterMs(header: string | null, fallback: number, now = Date.now()): number {
  let ms = fallback;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
    else { const d = Date.parse(header); if (Number.isFinite(d)) ms = d - now; }
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_WAIT_MS);
}

/** fetch with timeout, cancellation, 429/5xx retry with backoff. */
export async function fetchJson<T>(
  url: string,
  { signal, timeoutMs = 12_000, retries = 2, fetchImpl = fetch }: { signal?: AbortSignal; timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  let lastErr: ApiError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new ApiError("Request cancelled", "aborted");
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (res.status === 429) {
        lastErr = new ApiError("Meteora API rate limit reached (429). Try again shortly.", "rate-limit", 429);
        if (attempt >= retries) throw lastErr;
        await sleep(retryAfterMs(res.headers.get("retry-after"), 800 * 2 ** attempt), signal);
        continue;
      }
      if (!res.ok) {
        lastErr = new ApiError(`Meteora API returned HTTP ${res.status}`, "http", res.status);
        if (res.status >= 500 && attempt < retries) {
          await sleep(600 * 2 ** attempt, signal);
          continue;
        }
        throw lastErr;
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new ApiError("Meteora API returned unreadable data", "parse");
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (signal?.aborted) throw new ApiError("Request cancelled", "aborted");
      if (ctl.signal.aborted) lastErr = new ApiError(`Meteora API timed out after ${timeoutMs / 1000}s`, "timeout");
      else lastErr = new ApiError("Network error reaching Meteora API", "network");
      if (attempt < retries) await sleep(500 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr ?? new ApiError("Unknown error", "network");
}

export interface PoolQuery {
  page: number;
  pageSize: number;
  query?: string;
  sort: SortKey;
  dir: "asc" | "desc";
  hideBlacklisted?: boolean;
}

export function buildPoolsUrl(q: PoolQuery): string {
  const p = new URLSearchParams();
  p.set("page", String(q.page));
  p.set("page_size", String(q.pageSize));
  p.set("sort_by", `${q.sort}:${q.dir}`);
  if (q.query?.trim()) p.set("query", q.query.trim());
  if (q.hideBlacklisted) p.set("filter_by", "is_blacklisted=false");
  return `${METEORA_API}/pools?${p.toString()}`;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const finRec = (r: unknown): Record<string, number> | undefined => {
  if (!r || typeof r !== "object") return undefined;
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) { const n = fin(v); if (n !== undefined) o[k] = n; }
  return o;
};
function normToken(t: unknown): ApiToken | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = t as any;
  if (!o || typeof o.address !== "string" || !B58.test(o.address)) return null;
  const dec = fin(o.decimals);
  return {
    address: o.address,
    name: typeof o.name === "string" ? o.name : undefined,
    symbol: typeof o.symbol === "string" ? o.symbol : undefined,
    decimals: dec !== undefined && Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : undefined,
    is_verified: typeof o.is_verified === "boolean" ? o.is_verified : undefined,
    price: fin(o.price),
  };
}
/** Validate one live pool row. Invalid addresses drop the row; non-finite numbers become undefined (shown as —). */
export function normalizePool(raw: unknown): ApiPool | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = raw as any;
  if (!o || typeof o.address !== "string" || !B58.test(o.address)) return null;
  const tx = normToken(o.token_x), ty = normToken(o.token_y);
  if (!tx || !ty) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = (o.pool_config ?? {}) as any;
  return {
    address: o.address,
    name: typeof o.name === "string" ? o.name : undefined,
    token_x: tx, token_y: ty,
    tvl: fin(o.tvl), current_price: fin(o.current_price),
    volume: finRec(o.volume), fees: finRec(o.fees), fee_tvl_ratio: finRec(o.fee_tvl_ratio),
    pool_config: { bin_step: fin(pc.bin_step), base_fee_pct: fin(pc.base_fee_pct), max_fee_pct: fin(pc.max_fee_pct), protocol_fee_pct: fin(pc.protocol_fee_pct) },
    dynamic_fee_pct: fin(o.dynamic_fee_pct),
    is_blacklisted: typeof o.is_blacklisted === "boolean" ? o.is_blacklisted : undefined,
    has_farm: typeof o.has_farm === "boolean" ? o.has_farm : undefined,
    created_at: fin(o.created_at),
    token_x_amount: fin(o.token_x_amount), token_y_amount: fin(o.token_y_amount),
    tags: Array.isArray(o.tags) ? o.tags.filter((t: unknown): t is string => typeof t === "string") : undefined,
    launchpad: typeof o.launchpad === "string" ? o.launchpad : undefined,
  };
}

/**
 * fee_tvl_ratio from the API is ALREADY a percentage: verified 2026-10-06 on YZY-USDC,
 * fees24h 4.1654 / tvl 37,614,365 × 100 = 1.1074e-5 == fee_tvl_ratio['24h'].
 */
export function feeTvlPct(p: ApiPool): number | undefined { return v24(p.fee_tvl_ratio); }

export async function fetchPools(q: PoolQuery, signal?: AbortSignal): Promise<PoolPage> {
  const page = await fetchJson<PoolPage>(buildPoolsUrl(q), { signal });
  if (!page || !Array.isArray(page.data)) throw new ApiError("Unexpected pool list shape", "parse");
  return { ...page, data: page.data.map(normalizePool).filter((p): p is ApiPool => p !== null) };
}

export async function fetchPool(address: string, signal?: AbortSignal): Promise<ApiPool> {
  const p = await fetchJson<ApiPool>(`${METEORA_API}/pools/${encodeURIComponent(address)}`, { signal });
  const n = normalizePool(p);
  if (!n) throw new ApiError("Pool not found in Meteora API, or its data failed validation", "parse");
  return n;
}

export const v24 = (r?: Record<string, number>) => (r && typeof r["24h"] === "number" ? r["24h"] : undefined);

/* ---------------- OHLCV (price history) ---------------- */
export const OHLCV_FRAMES = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] as const;
export type OhlcvFrame = (typeof OHLCV_FRAMES)[number];
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
/** Validate rows: finite, positive prices, h>=max(o,c), l<=min(o,c); drop anything else. Sorted ascending, deduped. */
export function normalizeCandles(raw: unknown): Candle[] {
  const rows = (raw as { data?: unknown })?.data;
  if (!Array.isArray(rows)) throw new ApiError("Unexpected price-history shape", "parse");
  const out = new Map<number, Candle>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows as any[]) {
    const t = fin(r?.timestamp), o = fin(r?.open), h = fin(r?.high), l = fin(r?.low), c = fin(r?.close), v = fin(r?.volume);
    if (t === undefined || o === undefined || h === undefined || l === undefined || c === undefined) continue;
    if (o <= 0 || c <= 0 || l <= 0 || h < Math.max(o, c) || l > Math.min(o, c)) continue;
    out.set(t, { t, o, h, l, c, v: v ?? 0 });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
export async function fetchOhlcv(address: string, frame: OhlcvFrame, startSec: number, endSec: number, signal?: AbortSignal): Promise<Candle[]> {
  if (!B58.test(address)) throw new ApiError("Invalid pool address", "parse");
  const u = `${METEORA_API}/pools/${encodeURIComponent(address)}/ohlcv?timeframe=${frame}&start_time=${Math.floor(startSec)}&end_time=${Math.floor(endSec)}`;
  return normalizeCandles(await fetchJson<unknown>(u, { signal }));
}

/* ---------------- Indexed portfolio (mainnet only) ---------------- */
export interface IndexedPool {
  poolAddress: string; tokenX?: string; tokenY?: string; tokenXMint: string; tokenYMint: string;
  listPositions: string[]; openPositionCount?: number; positionsOutOfRange?: number;
  balances?: number; unclaimedFees?: number; pnl?: number; pnlPctChange?: number;
  poolPrice?: number; binStep?: number; poolStateUpdatedAtSlot?: number; poolStateUpdatedAtBlockTime?: number;
}
export interface IndexedPortfolio { pools: IndexedPool[]; totalPositions?: number; fetchedAt: number; pages: number }
export function normalizeIndexedPool(raw: unknown): IndexedPool | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = raw as any;
  if (!o) return null;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const addr = s("poolAddress"), mx = s("tokenXMint"), my = s("tokenYMint");
  if (!addr || !B58.test(addr) || !mx || !B58.test(mx) || !my || !B58.test(my)) return null;
  const list = Array.isArray(o.listPositions) ? (o.listPositions as unknown[]).filter((x): x is string => typeof x === "string" && B58.test(x)) : [];
  const num = (k: string) => { const v = o[k]; const n = typeof v === "string" ? Number(v) : v; return fin(n); };
  return {
    poolAddress: addr, tokenX: s("tokenX"), tokenY: s("tokenY"), tokenXMint: mx, tokenYMint: my, listPositions: list,
    openPositionCount: num("openPositionCount"), positionsOutOfRange: num("positionsOutOfRange"),
    balances: num("balances"), unclaimedFees: num("unclaimedFees"), pnl: num("pnl"), pnlPctChange: num("pnlPctChange"),
    poolPrice: num("poolPrice"), binStep: num("binStep"),
    poolStateUpdatedAtSlot: num("poolStateUpdatedAtSlot"), poolStateUpdatedAtBlockTime: num("poolStateUpdatedAtBlockTime"),
  };
}
/** GET /portfolio/open — paginates with hasNext, bounded to 10 pages. Mainnet index only. */
export async function fetchIndexedPortfolio(user: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<IndexedPortfolio> {
  if (!B58.test(user)) throw new ApiError("Not a valid Solana address", "parse");
  const pools: IndexedPool[] = [];
  let page = 1, total: number | undefined;
  for (; page <= 10; page++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await fetchJson<any>(`${METEORA_API}/portfolio/open?user=${encodeURIComponent(user)}&page=${page}&page_size=50`, { signal, fetchImpl });
    if (!r || !Array.isArray(r.pools)) throw new ApiError("Unexpected portfolio shape", "parse");
    for (const p of r.pools) { const n = normalizeIndexedPool(p); if (n) pools.push(n); }
    total = fin(r.totalPositions);
    if (r.hasNext !== true) break;
  }
  return { pools, totalPositions: total, fetchedAt: Date.now(), pages: page };
}

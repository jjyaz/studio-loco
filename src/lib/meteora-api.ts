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

export type SortKey = "tvl" | "volume_24h" | "fee_24h" | "fee_tvl_ratio_24h" | "bin_step";
export const SORT_LABELS: Record<SortKey, string> = {
  tvl: "TVL",
  volume_24h: "Volume 24h",
  fee_24h: "Fees 24h",
  fee_tvl_ratio_24h: "Fee / TVL 24h",
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        lastErr = new ApiError("Meteora API rate limit reached (429). Retrying…", "rate-limit", 429);
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        lastErr = new ApiError(`Meteora API returned HTTP ${res.status}`, "http", res.status);
        if (res.status >= 500 && attempt < retries) {
          await sleep(600 * 2 ** attempt);
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
      if (attempt < retries) await sleep(500 * 2 ** attempt);
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

export async function fetchPools(q: PoolQuery, signal?: AbortSignal): Promise<PoolPage> {
  const page = await fetchJson<PoolPage>(buildPoolsUrl(q), { signal });
  if (!page || !Array.isArray(page.data)) throw new ApiError("Unexpected pool list shape", "parse");
  return page;
}

export async function fetchPool(address: string, signal?: AbortSignal): Promise<ApiPool> {
  const p = await fetchJson<ApiPool>(`${METEORA_API}/pools/${encodeURIComponent(address)}`, { signal });
  if (!p || typeof p.address !== "string") throw new ApiError("Pool not found in Meteora API", "parse");
  return p;
}

export const v24 = (r?: Record<string, number>) => (r && typeof r["24h"] === "number" ? r["24h"] : undefined);

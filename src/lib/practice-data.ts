import type { ApiPool, PoolPage, PoolQuery } from "./meteora-api";

/**
 * PRACTICE DATA — fictional, seeded examples for exploring the UI.
 * Only shown after the user explicitly enables Practice mode.
 * Addresses are deliberately invalid placeholders; nothing here can be transacted.
 */
const mk = (i: number, name: string, binStep: number, tvl: number, vol: number, fee: number, dyn: number): ApiPool => {
  const [x, y] = name.split("-");
  return {
    address: `PRACTICE-${String(i).padStart(3, "0")}`,
    name,
    token_x: { address: `PRACTICE-MINT-${x}`, symbol: x, decimals: 9 },
    token_y: { address: `PRACTICE-MINT-${y}`, symbol: y, decimals: 6 },
    tvl,
    volume: { "24h": vol },
    fees: { "24h": vol * (fee / 100) },
    fee_tvl_ratio: { "24h": tvl ? (vol * (fee / 100)) / tvl : 0 },
    pool_config: { bin_step: binStep, base_fee_pct: fee },
    dynamic_fee_pct: dyn,
    is_blacklisted: i === 7,
    current_price: 1 + i * 0.37,
  };
};

export const PRACTICE_POOLS: ApiPool[] = [
  mk(1, "TRAIN-USDC", 10, 1_200_000, 340_000, 0.1, 0.02),
  mk(2, "FIELD-USDC", 25, 640_000, 820_000, 0.25, 0.11),
  mk(3, "CLOUD-SOL", 80, 90_000, 150_000, 0.8, 0.4),
  mk(4, "STATION-USDC", 5, 2_400_000, 410_000, 0.05, 0),
  mk(5, "LANTERN-SOL", 100, 40_000, 12_000, 1, 0.9),
  mk(6, "SIGNAL-USDC", 20, 310_000, 95_000, 0.2, 0.06),
  mk(7, "DITHER-SOL", 200, 8_000, 30_000, 2, 1.5),
  mk(8, "TICKET-USDC", 15, 520_000, 260_000, 0.15, 0.03),
];

export function practicePage(q: PoolQuery): PoolPage {
  let rows = PRACTICE_POOLS.filter((p) => !q.query || (p.name ?? "").toLowerCase().includes(q.query.toLowerCase()));
  if (q.hideBlacklisted) rows = rows.filter((p) => !p.is_blacklisted);
  const val = (p: ApiPool) =>
    q.sort === "tvl" ? p.tvl ?? 0
    : q.sort === "volume_24h" ? p.volume?.["24h"] ?? 0
    : q.sort === "fees_24h" ? p.fees?.["24h"] ?? 0
    : q.sort === "fee_tvl_ratio_24h" ? p.fee_tvl_ratio?.["24h"] ?? 0
    : p.pool_config?.bin_step ?? 0;
  rows = [...rows].sort((a, b) => (q.dir === "desc" ? val(b) - val(a) : val(a) - val(b)));
  const start = (q.page - 1) * q.pageSize;
  return {
    data: rows.slice(start, start + q.pageSize),
    current_page: q.page,
    page_size: q.pageSize,
    pages: Math.max(1, Math.ceil(rows.length / q.pageSize)),
    total: rows.length,
  };
}

export const isPracticeAddress = (a: string) => a.startsWith("PRACTICE-");

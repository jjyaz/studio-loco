export const DASH = "—";

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function fmtUsd(n: unknown, compact = true): string {
  if (!isNum(n)) return DASH;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact && Math.abs(n) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
  }).format(n);
}

export function fmtNum(n: unknown, digits = 4): string {
  if (!isNum(n)) return DASH;
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e6) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  if (a < 1e-4) return n.toExponential(3);
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits + 2 }).format(n);
}

export function fmtPct(n: unknown, digits = 2): string {
  if (!isNum(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

export function shortAddr(a: string | undefined | null, n = 4): string {
  if (!a) return DASH;
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return DASH;
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function explorerTx(sig: string, cluster: "mainnet-beta" | "devnet"): string {
  return `https://solscan.io/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}
export function explorerAccount(addr: string, cluster: "mainnet-beta" | "devnet"): string {
  return `https://solscan.io/account/${addr}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

export const isBase58Address = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

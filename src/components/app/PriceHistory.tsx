import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useId } from "react";
import { fetchOhlcv, type Candle, type OhlcvFrame } from "@/lib/meteora-api";
import { redactUrls } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Range presets → candle interval. Only intervals the API accepts. */
const RANGES: { id: string; label: string; secs: number; frame: OhlcvFrame }[] = [
  { id: "1d", label: "24H", secs: 86_400, frame: "30m" },
  { id: "7d", label: "7D", secs: 7 * 86_400, frame: "4h" },
  { id: "30d", label: "30D", secs: 30 * 86_400, frame: "12h" },
  { id: "90d", label: "90D", secs: 90 * 86_400, frame: "24h" },
];

const fmtP = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(5));
const fmtT = (t: number, long: boolean) =>
  new Date(t * 1000).toLocaleString(undefined, long ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });

export function PriceHistory({ address, symX, symY, currentPrice }: { address: string; symX: string; symY: string; currentPrice?: number }) {
  const [rid, setRid] = useState("7d");
  const range = RANGES.find((r) => r.id === rid)!;
  const q = useQuery({
    queryKey: ["ohlcv", "mainnet-beta", address, range.id],
    queryFn: ({ signal }) => {
      const end = Math.floor(Date.now() / 1000);
      return fetchOhlcv(address, range.frame, end - range.secs, end, signal);
    },
    staleTime: 60_000,
    retry: 1,
  });
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="station-code text-amber">Price history · Meteora API</h2>
          <p className="mt-1 text-xs text-cream/70">{symY} per {symX} · {range.frame} candles · indexed mainnet data</p>
        </div>
        <div role="group" aria-label="Time range" className="flex border border-line">
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={r.id === rid} onClick={() => setRid(r.id)}
              className={cn("station-code min-h-10 min-w-12 px-3", r.id === rid ? "bg-amber text-midnight" : "text-cream/80 hover:text-amber")}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4">
        {q.isPending && <p className="py-16 text-center station-code text-cream/70">Loading candles…</p>}
        {q.isError && (
          <div className="border border-destructive p-4 text-sm">
            <p className="text-destructive">Price history unavailable: {redactUrls((q.error as Error).message)}</p>
            <button type="button" className="station-code mt-2 min-h-9 border border-amber px-3 text-amber" onClick={() => q.refetch()}>Retry</button>
          </div>
        )}
        {q.data && q.data.length === 0 && <p className="border border-line p-4 text-sm text-cream/75">No candles were returned for this range. Nothing is drawn rather than guessing a line.</p>}
        {q.data && q.data.length > 0 && <Chart candles={q.data} long={range.secs > 86_400} symX={symX} symY={symY} currentPrice={currentPrice} />}
      </div>
    </div>
  );
}

function Chart({ candles, long, symX, symY, currentPrice }: { candles: Candle[]; long: boolean; symX: string; symY: string; currentPrice?: number }) {
  const W = 560, H = 260, P = { l: 8, r: 78, t: 14, b: 30 };
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const { lo, hi, x, y, step } = useMemo(() => {
    let lo = Math.min(...candles.map((c) => c.l)), hi = Math.max(...candles.map((c) => c.h));
    if (lo === hi) { lo *= 0.99; hi *= 1.01; }
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const step = (W - P.l - P.r) / candles.length;
    return { lo, hi, step, x: (i: number) => P.l + step * (i + 0.5), y: (v: number) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b) };
  }, [candles]);
  const first = candles[0]!, last = candles[candles.length - 1]!;
  const sel = hover !== null ? candles[hover]! : last;
  const change = ((last.c - first.o) / first.o) * 100;
  // Sanity: API current_price should sit near the last close (same orientation: Y per X).
  const mismatch = currentPrice !== undefined && currentPrice > 0 && Math.abs(currentPrice / last.c - 1) > 0.5;
  const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * (1 - f));
  const bw = Math.max(1, Math.min(10, step * 0.6));
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? candles.length) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(candles.length - 1, (h ?? -1) + 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  }
  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-sm tabular" aria-live="polite">
        <span className="text-cream/65">{new Date(sel.t * 1000).toLocaleString()}</span>
        <span>O {fmtP(sel.o)}</span><span>H {fmtP(sel.h)}</span><span>L {fmtP(sel.l)}</span><span className="text-amber">C {fmtP(sel.c)}</span>
        <span className="text-cream/65">Vol ${sel.v.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        <span className={change >= 0 ? "text-success" : "text-destructive"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}% range</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full border border-line bg-midnight/60 focus-visible:outline-2 focus-visible:outline-amber" role="img" aria-labelledby={titleId}
        tabIndex={0} onKeyDown={onKey} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(candles.length - 1, Math.floor((px - P.l) / step))));
        }}>
        <title id={titleId}>{`${symY} per ${symX}: ${candles.length} candles from ${fmtP(first.o)} to ${fmtP(last.c)}. Use arrow keys to read candles.`}</title>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--cream)" strokeOpacity={0.12} strokeDasharray="2 4" />
            <text x={W - P.r + 6} y={y(v) + 4} fontSize={15} fill="var(--cream)" fillOpacity={0.7} fontFamily="Space Mono, monospace">{fmtP(v)}</text>
          </g>
        ))}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? "var(--amber)" : "var(--cream)";
          return (
            <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.55}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - bw / 2} width={bw} y={y(Math.max(c.o, c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={up ? col : "var(--midnight)"} stroke={col} strokeWidth={1} />
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--amber)" strokeOpacity={0.6} />}
        {[0, Math.floor(candles.length / 2), candles.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 6} fontSize={15} textAnchor="middle" fill="var(--cream)" fillOpacity={0.65} fontFamily="Space Mono, monospace">{fmtT(candles[i]!.t, long)}</text>
        ))}
      </svg>
      <figcaption className="mt-2 text-xs text-cream/60">
        Real candles from Meteora's indexed API; gaps mean no data was returned. Not a forecast.
        {mismatch && " Note: the latest close differs a lot from the pool's reported current price — the index may be lagging."}
      </figcaption>
    </figure>
  );
}

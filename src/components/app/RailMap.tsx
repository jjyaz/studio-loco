import { formatUnits } from "@/lib/amount";
import { fmtNum } from "@/lib/format";

export interface RailBin {
  binId: number;
  xAmount: string; // raw
  yAmount: string; // raw
  price: number; // UI price Y per X
}

/**
 * Rail Map: real bins as discrete price stations. Bar height = bin liquidity valued in Y
 * (x * price + y). Active bin marked with the train. Optional selected range overlay.
 */
export function RailMap({ bins, activeId, decX, decY, symX, symY, range }: { bins: RailBin[]; activeId: number; decX: number; decY: number; symX: string; symY: string; range?: [number, number] }) {
  if (bins.length === 0) return <p className="text-sm text-cream/70">No bins returned around the active bin.</p>;
  const vals = bins.map((b) => Number(formatUnits(b.xAmount, decX).replace(/,/g, "")) * b.price + Number(formatUnits(b.yAmount, decY).replace(/,/g, "")));
  const max = Math.max(...vals, 1e-18);
  const W = 800;
  const H = 220;
  const bw = W / bins.length;
  const active = bins.find((b) => b.binId === activeId);
  const first = bins[0]!;
  const last = bins[bins.length - 1]!;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H + 50}`} className="w-full" role="img" aria-label={`Rail map of ${bins.length} bins around active bin ${activeId}`}>
        {range && (() => {
          const i0 = bins.findIndex((b) => b.binId >= range[0]);
          const i1 = bins.findIndex((b) => b.binId > range[1]);
          const a = Math.max(0, i0 === -1 ? bins.length : i0);
          const z = i1 === -1 ? bins.length : i1;
          return z > a ? <rect x={a * bw} y={0} width={(z - a) * bw} height={H} fill="var(--ultramarine)" opacity={0.55} /> : null;
        })()}
        {bins.map((b, i) => {
          const h = ((vals[i] ?? 0) / max) * (H - 20);
          const isActive = b.binId === activeId;
          const above = b.binId > activeId;
          return (
            <rect key={b.binId} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1.5)} height={h} fill={isActive ? "var(--ochre)" : above ? "var(--amber)" : "var(--cream)"} opacity={isActive ? 1 : 0.9}>
              <title>{`Bin ${b.binId} · price ${fmtNum(b.price, 6)} ${symY}/${symX} · ${formatUnits(b.xAmount, decX, 4)} ${symX} · ${formatUnits(b.yAmount, decY, 4)} ${symY}`}</title>
            </rect>
          );
        })}
        <line x1={0} x2={W} y1={H + 6} y2={H + 6} stroke="var(--cream)" strokeOpacity={0.5} />
        <line x1={0} x2={W} y1={H + 12} y2={H + 12} stroke="var(--cream)" strokeOpacity={0.5} />
        {bins.map((b, i) => (i % 5 === 0 ? <rect key={`s${b.binId}`} x={i * bw} y={H + 4} width={2} height={10} fill="var(--cream)" opacity={0.6} /> : null))}
        {active && (() => {
          const i = bins.indexOf(active);
          const x = i * bw + bw / 2;
          return (
            <g transform={`translate(${x - 18}, ${H + 16})`}>
              <rect width={36} height={14} fill="var(--ochre)" />
              <rect x={30} y={0} width={6} height={14} fill="var(--destructive)" />
              {[4, 11, 18, 25].map((wx) => <rect key={wx} x={wx} y={3} width={4} height={5} fill="var(--amber)" />)}
            </g>
          );
        })()}
      </svg>
      <figcaption className="mt-2 flex flex-wrap justify-between gap-2 station-code text-cream/70">
        <span>{fmtNum(first.price, 6)}</span>
        <span className="text-amber">Active #{activeId} · {active ? fmtNum(active.price, 6) : "—"} {symY}/{symX}</span>
        <span>{fmtNum(last.price, 6)}</span>
      </figcaption>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-cream/75">
        <span className="flex items-center gap-2"><span className="size-3 bg-cream" /> {symY} (below)</span>
        <span className="flex items-center gap-2"><span className="size-3 bg-amber" /> {symX} (above)</span>
        <span className="flex items-center gap-2"><span className="size-3 bg-ochre" /> Active bin</span>
        {range && <span className="flex items-center gap-2"><span className="size-3 bg-ultramarine" /> Your range</span>}
      </div>
    </figure>
  );
}

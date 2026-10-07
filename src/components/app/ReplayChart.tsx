import { FRAME_MS } from "@/lib/agents";
import type { ReplayResult, ReplayTape } from "@/lib/replay";

const priceText = (n: number) =>
  n >= 100 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(4);

export function ReplayChart({
  tape,
  result,
  selected,
}: {
  tape: ReplayTape;
  result: ReplayResult;
  selected: number;
}) {
  const width = 760,
    height = 310,
    left = 65,
    right = 20,
    top = 20,
    bottom = 40;
  const series = result.points;
  const minimum = Math.min(...series.map((p) => Math.min(p.candle.l, p.lowPrice)));
  const maximum = Math.max(...series.map((p) => Math.max(p.candle.h, p.highPrice)));
  const padding = Math.max((maximum - minimum) * 0.08, minimum * 0.001);
  const low = minimum - padding,
    high = maximum + padding;
  const x = (t: number) =>
    left + ((t - tape.startSec) / (tape.endSec - tape.startSec)) * (width - left - right);
  const closeX = (t: number) => x(t + FRAME_MS[tape.frame] / 1000);
  const y = (p: number) => top + ((high - p) / (high - low)) * (height - top - bottom);
  const barWidth =
    (FRAME_MS[tape.frame] / 1000 / (tape.endSec - tape.startSec)) * (width - left - right);
  const lines: string[] = [];
  let line = "";
  for (const point of series) {
    if (point.gapBefore) {
      if (line) lines.push(line);
      line = "";
    }
    line += `${line ? " L" : "M"}${closeX(point.candle.t).toFixed(2)},${y(point.candle.c).toFixed(2)}`;
  }
  if (line) lines.push(line);
  const current = series[selected] ?? series[0]!;
  return (
    <div
      className="overflow-x-auto border border-line bg-midnight"
      tabIndex={0}
      aria-label="Historical price and modeled range chart; scroll horizontally on small screens"
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-[640px] w-full"
        role="img"
        aria-labelledby="replay-chart-title replay-chart-desc"
      >
        <title id="replay-chart-title">Completed candle closes and modeled liquidity range</title>
        <desc id="replay-chart-desc">
          Amber line shows Y per X closing prices. Blue bands show the inferred bin range. White
          dots mark rebalance proposals and orange dots mark risk proposals. Missing periods are
          left blank. Use the observation slider below to inspect each close.
        </desc>
        {Array.from({ length: 5 }, (_, i) => {
          const price = low + ((high - low) * i) / 4;
          const yy = y(price);
          return (
            <g key={i}>
              <line
                x1={left}
                x2={width - right}
                y1={yy}
                y2={yy}
                stroke="#f1e6c9"
                strokeOpacity="0.12"
              />
              <text
                x={left - 9}
                y={yy + 4}
                textAnchor="end"
                fill="#f1e6c9"
                opacity="0.7"
                fontFamily="monospace"
                fontSize="11"
              >
                {priceText(price)}
              </text>
            </g>
          );
        })}
        {series.map((p, i) => (
          <g key={p.candle.t}>
            {!p.bootstrap && (
              <rect
                x={x(p.candle.t)}
                y={y(p.highPrice)}
                width={barWidth}
                height={y(p.lowPrice) - y(p.highPrice)}
                fill="#426fe5"
                fillOpacity="0.28"
              />
            )}
            {!p.bootstrap && (
              <line
                x1={closeX(p.candle.t)}
                x2={closeX(p.candle.t)}
                y1={y(p.candle.h)}
                y2={y(p.candle.l)}
                stroke="#f1e6c9"
                strokeOpacity="0.2"
              />
            )}
            {p.proposal && (
              <circle
                cx={closeX(p.candle.t)}
                cy={y(p.candle.c)}
                r={i === selected ? 5 : 3}
                fill={p.proposal.kind === "reduce" ? "#e87945" : "#f1e6c9"}
                stroke="#0a1635"
                strokeWidth="1"
              />
            )}
          </g>
        ))}
        {lines.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#f6b53e" strokeWidth="2" />
        ))}
        <line
          x1={closeX(current.candle.t)}
          x2={closeX(current.candle.t)}
          y1={top}
          y2={height - bottom}
          stroke="#f1e6c9"
          strokeDasharray="3 4"
          strokeOpacity="0.55"
        />
        <circle
          cx={closeX(current.candle.t)}
          cy={y(current.candle.c)}
          r="5"
          fill="#f6b53e"
          stroke="#0a1635"
          strokeWidth="2"
        />
        {Array.from({ length: 5 }, (_, i) => {
          const t = tape.startSec + ((tape.endSec - tape.startSec) * i) / 4;
          return (
            <text
              key={i}
              x={x(t)}
              y={height - 14}
              textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              fill="#f1e6c9"
              opacity="0.65"
              fontFamily="monospace"
              fontSize="11"
            >
              {new Date(t * 1000).toISOString().slice(5, 16).replace("T", " ")}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

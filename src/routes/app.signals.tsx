import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import BN from "bn.js";
import { Btn, Cap, Notice, PageHead, Panel, Spinner, Stat } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { usePositions, rangeState, type PositionRow } from "@/components/app/positions";
import { fetchPools, v24 } from "@/lib/meteora-api";
import { formatUnits } from "@/lib/amount";
import { getPool, invalidatePool } from "@/lib/dlmm";
import { fmtPct, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { useLocalState, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { MAX_UI_BINS } from "@/lib/strategy";
import { skyOf } from "@/lib/derive";
import { attentionScore, clampRule, nextOutSince, riskLevel, type RiskRule } from "@/lib/signals-risk";

export const Route = createFileRoute("/app/signals")({
  head: () => ({
    meta: [
      { title: "Signal Box — Studio Loco" },
      { name: "description", content: "Watch your DLMM position ranges against the real active bin while the tab is open, and read actual Fee Weather." },
      { property: "og:title", content: "Signal Box — Studio Loco" },
      { property: "og:description", content: "In-tab range alerts, user-approved rebalance plans and real dynamic fee readings." },
    ],
  }),
  component: Signals,
});

function Signals() {
  const [tab, setTab] = useState<"watch" | "weather">("watch");
  return (
    <div>
      <PageHead code="ST-05 · Signal Box" title="Watch the lamps." intro="Signals run only while this tab is open. There is no keeper and nothing executes without your approval." cap={["live"]} />
      <p className="-mt-2 mb-6 text-sm text-cream/75">Want armed rules with reviewable rebalance and withdrawal proposals? Open <Link to="/app/agents" className="underline hover:text-amber">Liquidity Agents</Link>.</p>
      <div role="tablist" className="mb-6 flex border-b border-line">
        {(["watch", "weather"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn("station-code min-h-11 border-b-2 px-4", tab === t ? "border-amber text-amber" : "border-transparent text-cream/75")}>
            {t === "watch" ? "Range watch" : "Fee Weather"}
          </button>
        ))}
      </div>
      {tab === "watch" ? <Watch /> : <Weather />}
    </div>
  );
}

function Watch() {
  const { publicKey } = useWallet();
  const q = usePositions(30_000);
  const [rules, setRules] = useLocalState<Record<string, Partial<RiskRule>>>("studio-loco:signal-rules:v2", {});
  const [outSince, setOutSince] = useLocalState<Record<string, number>>("studio-loco:signal-out-since:v1", {});
  const [plan, setPlan] = useState<{ r: PositionRow; exitOnly: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  // Record first-observed out-of-range time per position (this browser only).
  useEffect(() => {
    if (!q.data) return;
    const t = Date.now();
    setOutSince((prev) => {
      const next: Record<string, number> = {};
      for (const r of q.data) {
        const v = nextOutSince(r.activeId < r.lower || r.activeId > r.upper, prev[r.key], t);
        if (v !== undefined) next[r.key] = v;
      }
      return next;
    });
  }, [q.data, q.dataUpdatedAt, setOutSince]);
  if (!publicKey) return <Panel><p className="mb-4 text-cream/80">Connect a wallet to watch your positions.</p><WalletButton /></Panel>;
  if (q.isPending) return <Spinner label="Reading positions" />;
  if (q.isError) return <Notice tone="error" title="Couldn't read positions" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{redactUrls(String(((q.error) as Error)?.message ?? ""))}. A dedicated RPC is usually required.</Notice>;
  if (!q.data.length) return <Panel><p>No positions to watch. <Link className="underline" to="/app">Open a pool</Link>.</p></Panel>;
  return (
    <div className="flex flex-col gap-4">
      <p className="station-code text-cream/70">Polling every 30s · last {timeAgo(q.dataUpdatedAt)}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data.map((r) => {
          const rule = clampRule(rules[r.key]);
          const buf = rule.buffer;
          const st = rangeState(r.activeId, r.lower, r.upper, buf);
          const lvl = riskLevel(st, outSince[r.key], rule, now);
          const setRule = (patch: Partial<RiskRule>) => setRules((m) => ({ ...m, [r.key]: clampRule({ ...rule, ...patch }) }));
          return (
            <Panel key={r.key}>
              <div className="flex justify-between gap-2">
                <div>
                  <Link to="/app/pool/$address" params={{ address: r.pair }} className="font-medium hover:text-amber">Pool {shortAddr(r.pair)}</Link>
                  <p className="station-code text-cream/60">Position {shortAddr(r.key)}</p>
                </div>
                <span className={cn("station-code h-fit border px-2 py-1", st === "in-range" && "border-success text-success", st === "approaching-edge" && "border-amber text-amber", st === "out-of-range" && "border-destructive text-destructive")}>
                  {st === "in-range" ? "Clear" : st === "approaching-edge" ? "Approaching edge" : "Out of range"}
                </span>
              </div>
              <RangeBar lower={r.lower} upper={r.upper} active={r.activeId} buffer={buf} />
              <div className="mt-3 flex items-center gap-3">
                <label htmlFor={`b-${r.key}`} className="station-code">Alert buffer</label>
                <input id={`b-${r.key}`} type="number" min={0} max={50} value={buf} onChange={(e) => setRule({ buffer: Number(e.target.value) })} className="min-h-10 w-20 border border-input bg-midnight px-2 font-mono" />
                <span className="text-xs text-cream/60">bins from either edge</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <label htmlFor={`m-${r.key}`} className="station-code">Exit threshold</label>
                <input id={`m-${r.key}`} type="number" min={0} max={1440} value={rule.outMinutes} onChange={(e) => setRule({ outMinutes: Number(e.target.value) })} className="min-h-10 w-20 border border-input bg-midnight px-2 font-mono" />
                <span className="text-xs text-cream/60">minutes out of range</span>
              </div>
              {(lvl === "out" || lvl === "plan-ready") && (
                <p className={cn("mt-3 text-sm", lvl === "plan-ready" ? "text-ochre" : "text-cream/80")} role="status">
                  {lvl === "plan-ready" ? "Threshold passed — your exit plan is ready to review. Nothing runs until you approve it." : `Out of range — first seen by this tab ${timeAgo(outSince[r.key] ?? now)}. Plan flags after ${rule.outMinutes} min.`}
                </p>
              )}
              {st !== "in-range" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn size="sm" variant={lvl === "plan-ready" ? undefined : "line"} onClick={() => setPlan({ r, exitOnly: true })}>Prepare exit plan</Btn>
                  <Btn size="sm" variant="line" onClick={() => setPlan({ r, exitOnly: false })}>Prepare rebalance plan</Btn>
                </div>
              )}
            </Panel>
          );
        })}
      </div>
      {plan && <Rebalance key={plan.r.key + String(plan.exitOnly)} r={plan.r} exitOnly={plan.exitOnly} onClose={() => setPlan(null)} />}
      <p className="text-xs text-cream/60">Out-of-range timers only count while this browser has seen the position; they are not an on-chain record.</p>
    </div>
  );
}

function RangeBar({ lower, upper, active, buffer }: { lower: number; upper: number; active: number; buffer: number }) {
  const lo = Math.min(lower, active) - 3;
  const hi = Math.max(upper, active) + 3;
  const pos = (b: number) => ((b - lo) / (hi - lo)) * 100;
  return (
    <div className="mt-4" aria-label={`Range ${lower} to ${upper}, active ${active}`} role="img">
      <div className="relative h-6 border-y border-line">
        <div className="absolute inset-y-0 bg-ultramarine" style={{ left: `${pos(lower)}%`, width: `${pos(upper + 1) - pos(lower)}%` }} />
        <div className="absolute inset-y-0 bg-amber/30" style={{ left: `${pos(lower)}%`, width: `${Math.max(0, pos(lower + buffer) - pos(lower))}%` }} />
        <div className="absolute inset-y-0 bg-amber/30" style={{ left: `${pos(upper + 1 - buffer)}%`, width: `${Math.max(0, pos(upper + 1) - pos(upper + 1 - buffer))}%` }} />
        <div className="absolute -top-1 h-8 w-1 bg-ochre" style={{ left: `${pos(active)}%` }} />
      </div>
      <div className="mt-1 flex justify-between station-code text-cream/60"><span>{lower}</span><span className="text-amber">active {active}</span><span>{upper}</span></div>
    </div>
  );
}

function Rebalance({ r, onClose, exitOnly }: { r: PositionRow; onClose: () => void; exitOnly: boolean }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { settings } = useSettings();
  const runner = useTxRunner();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const d = r.position.positionData;
  const width = r.upper - r.lower + 1;
  const xRaw = d.totalXAmount.split(".")[0] ?? "0";
  const yRaw = d.totalYAmount.split(".")[0] ?? "0";
  // Continuation must be a range the add flow accepts.
  const nextWidth = Math.min(width, MAX_UI_BINS);
  const nextHalf = Math.floor((nextWidth - 1) / 2);
  const step1Done = !!runner.steps?.length && runner.steps.every((s) => s.phase === "confirmed");

  async function step1() {
    if (!publicKey) return;
    setErr(null);
    try {
      invalidatePool(r.pair);
      const pool = await getPool(connection, r.pair, settings.cluster);
      const txs = await pool.removeLiquidity({ user: publicKey, position: r.position.publicKey, fromBinId: r.lower, toBinId: r.upper, bps: new BN(10_000), shouldClaimAndClose: true });
      await runner.run(txs.map((tx, i) => ({ label: `Step 1 · Remove, claim & close (${i + 1}/${txs.length})`, tx })));
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["bal"] });
    } catch (e) {
      setErr(redactUrls(e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <Panel tone="cobalt">
      <div className="flex justify-between"><h3 className="display text-2xl">{exitOnly ? "Exit plan" : "Rebalance plan"} · {shortAddr(r.key)}</h3><Btn size="sm" variant="ghost" onClick={onClose}>Close</Btn></div>
      {exitOnly ? <p className="mt-2 text-sm text-cream/80">One wallet approval: withdraw everything, claim fees and close. Tokens return to your wallet.</p> : <p className="mt-2 text-sm text-cream/80">This is not atomic. Two separate wallet approvals; between them, price can move and your tokens sit in your wallet.</p>}
      <ol className="mt-4 flex flex-col gap-4 text-sm">
        <li className="border-l-2 border-amber pl-4">
          <p className="font-medium">Step 1 — Withdraw 100%, claim fees, close position</p>
          <p className="text-cream/75">Current holdings: {formatUnits(xRaw, r.decX, 6)} X · {formatUnits(yRaw, r.decY, 6)} Y, plus unclaimed fees {formatUnits(d.feeX, r.decX, 6)} X · {formatUnits(d.feeY, r.decY, 6)} Y. Position rent is refunded.</p>
          <p className="text-cream/75">These are estimates from the current position state. The SDK's removeLiquidity instruction used here does not enforce a minimum withdrawn amount, so what you receive is whatever the bins hold when it lands.</p>
          <Btn size="sm" className="mt-2" onClick={step1} disabled={runner.running || !!step1Done}>{step1Done ? "Step 1 confirmed" : "Run step 1"}</Btn>
        </li>
        {!exitOnly && <li className={cn("border-l-2 pl-4", step1Done ? "border-amber" : "border-line opacity-60")}>
          <p className="font-medium">Step 2 — Add a new {nextWidth}-bin Spot position centred on the current active bin</p>
          {width > MAX_UI_BINS && <p className="text-amber">Your old position spans {width} bins; this interface opens new positions of at most {MAX_UI_BINS} bins, so step 2 is narrowed.</p>}
          <p className="text-cream/75">Opens the pool's Add Liquidity flow pre-filled. You review amounts against your fresh wallet balance and sign separately.</p>
          {step1Done ? (
            <Link to="/app/pool/$address" params={{ address: r.pair }} search={{ tab: "add", strategy: "Spot", below: nextHalf, above: nextWidth - 1 - nextHalf }} className="mt-2 inline-block underline">Continue to step 2 →</Link>
          ) : <p className="mt-2 station-code text-cream/60">Available after step 1 confirms</p>}
        </li>}
      </ol>
      {err && <Notice tone="error" title="Couldn't build step 1">{err}</Notice>}
      <TxSteps steps={runner.steps} />
    </Panel>
  );
}

function Weather() {
  const q = useQuery({ queryKey: ["weather"], queryFn: ({ signal }) => fetchPools({ page: 1, pageSize: 24, sort: "volume_24h", dir: "desc", hideBlacklisted: true }, signal), refetchInterval: 60_000, retry: false });
  const [byAttention, setByAttention] = useState(true);
  const rows = useMemo(() => {
    const list = (q.data?.data ?? []).map((p) => {
      const dyn = typeof p.dynamic_fee_pct === "number" && Number.isFinite(p.dynamic_fee_pct) ? p.dynamic_fee_pct : undefined;
      const base = typeof p.pool_config?.base_fee_pct === "number" && Number.isFinite(p.pool_config.base_fee_pct) ? p.pool_config.base_fee_pct : undefined;
      const h1 = p.volume?.["1h"];
      const h24 = v24(p.volume);
      const pace = h1 !== undefined && h24 ? (h1 * 24) / h24 : undefined;
      const att = attentionScore({ dynamicPct: dyn, basePct: base, pace, feeTvlPct: p.fee_tvl_ratio?.["24h"] });
      return { p, dyn, base, h24, pace, att };
    });
    if (byAttention) list.sort((a, b) => (b.att?.score ?? -1) - (a.att?.score ?? -1));
    return list;
  }, [q.data, byAttention]);
  if (q.isPending) return <Spinner label="Reading the sky" />;
  if (q.isError) return <Notice tone="error" title="Fee Weather unavailable" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{redactUrls(String(((q.error) as Error)?.message ?? ""))}</Notice>;
  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-cream/80">Current readings for the 24 busiest pools by 24h volume. A dynamic fee above zero means recent volatility pushed the variable fee up. These are observations, not forecasts. The attention score (0–100) blends fee pressure, 1h pace and 24h fee/TVL to show where activity is now — it is not a yield estimate; any missing reading shows —. <span className="station-code text-cream/60">Updated {timeAgo(q.dataUpdatedAt)}</span></p>
      <label className="mb-4 flex items-center gap-2 station-code"><input type="checkbox" checked={byAttention} onChange={(e) => setByAttention(e.target.checked)} /> Sort by attention</label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map(({ p, dyn, base, h24, pace, att }) => {
          const sky = skyOf(dyn, base);
          return (
            <Link key={p.address} to="/app/pool/$address" params={{ address: p.address }} className="ticket block p-4 hover:bg-cobalt">
              <div className="flex justify-between"><span className="font-medium">{p.name}</span><span className={cn("station-code", sky === "Storm" ? "text-ochre" : sky === "Breezy" ? "text-amber" : "text-cream/70")}>{sky === "Unavailable" ? "— Unavailable" : sky}</span></div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Stat label="Base fee" value={fmtPct(base)} />
                <Stat label="Dynamic" value={fmtPct(p.dynamic_fee_pct)} />
                <Stat label="Vol 24h" value={fmtUsd(h24)} />
                <Stat label="1h pace" value={pace !== undefined ? `${pace.toFixed(2)}×` : "—"} sub="1h×24 / 24h" />
              </div>
              <div className="mt-3 border-t border-line pt-2" aria-label={att ? `Attention score ${att.score} of 100` : "Attention score unavailable"}>
                <div className="flex justify-between station-code"><span>Attention</span><span className="text-amber">{att ? `${att.score}/100` : "—"}</span></div>
                <div className="mt-1 h-1.5 bg-midnight"><div className="h-full bg-amber" style={{ width: `${att?.score ?? 0}%` }} /></div>
                {att && <p className="mt-1 text-xs text-cream/60">fee {att.parts.fee} · pace {att.parts.pace} · fee/TVL {att.parts.yield}</p>}
              </div>
            </Link>
          );
        })}
      </div>
      <div className="mt-4"><Cap kind="live" /></div>
    </div>
  );
}

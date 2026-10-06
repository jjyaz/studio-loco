import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { Btn, Cap, Field, Notice, PageHead, Panel, Segmented, Stat } from "@/components/kit";
import { usePoolSnapshot } from "@/components/app/pool-hooks";
import { fetchPools } from "@/lib/meteora-api";
import { pctMoveBetweenBins, uiPriceFromBin } from "@/lib/bins";
import { fmtNum, fmtPct, isBase58Address, shortAddr } from "@/lib/format";
import { useLocalState, useSettings, type Cluster } from "@/lib/settings";
import { parseUnits } from "@/lib/amount";
import { MAX_UI_BINS, STRATEGIES, TEMPLATES, DECIMAL_TEXT, decodeShare, distribute, loadStoredRoutes, encodeShare, exportRoutes, importRoutes, type SavedRoute, type StrategyName } from "@/lib/strategy";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/studio")({
  validateSearch: zodValidator(z.object({ r: z.string().max(4000).optional().catch(undefined) })),
  head: () => ({
    meta: [
      { title: "Strategy Studio — Studio Loco" },
      { name: "description", content: "Compose railway-style DLMM allocation routes: Spot, Curve and BidAsk across real pool bins. Save, share and execute one with your wallet." },
      { property: "og:title", content: "Strategy Studio — Studio Loco" },
      { property: "og:description", content: "Design DLMM liquidity routes with honest simulations and real SDK execution." },
    ],
  }),
  component: Studio,
});

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));

function Studio() {
  const { r } = Route.useSearch();
  const { settings } = useSettings();
  const [routes, setRoutes] = useLocalState<SavedRoute[]>("studio-loco:routes:v1", [], loadStoredRoutes);
  /** cluster this plan belongs to; null = migrated v1 route without identity */
  const [planCluster, setPlanCluster] = useState<Cluster | null>(null);
  const [xAmt, setXAmt] = useState("");
  const [yAmt, setYAmt] = useState("");
  const [pool, setPool] = useState("");
  const [poolName, setPoolName] = useState("");
  const [search, setSearch] = useState("");
  const [strategy, setStrategy] = useState<StrategyName>("Spot");
  const [below, setBelow] = useState(34);
  const [above, setAbove] = useState(34);
  const [budget, setBudget] = useState("1000");
  const [xShare, setXShare] = useState(50);
  const [shift, setShift] = useState(0);
  const [name, setName] = useState("My route");
  const [routeMigrated, setRouteMigrated] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!r) return;
    const shared = decodeShare(r);
    if (shared) load(shared);
    else setMsg({ tone: "error", text: "The shared route link is invalid or corrupted." });
  }, [r]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useQuery({
    queryKey: ["studio-search", search],
    enabled: search.trim().length >= 2,
    queryFn: ({ signal }) => fetchPools({ page: 1, pageSize: 8, query: search, sort: "tvl", dir: "desc", hideBlacklisted: true }, signal),
    retry: false,
  });
  const effCluster = planCluster ?? settings.cluster;
  const clusterMismatch = planCluster !== null && planCluster !== settings.cluster;
  // Only read chain state for a valid pool on the plan's own cluster.
  const snap = usePoolSnapshot(isBase58Address(pool) ? pool : "", 1, { cluster: effCluster });
  const live = isBase58Address(pool) && snap.data && !clusterMismatch ? snap.data : null;
  const exX = xAmt.trim() ? (live ? parseUnits(xAmt, live.decX) : DECIMAL_TEXT.test(xAmt) ? { ok: true as const } : { ok: false as const, error: "Not a decimal amount" }) : { ok: true as const };
  const exY = yAmt.trim() ? (live ? parseUnits(yAmt, live.decY) : DECIMAL_TEXT.test(yAmt) ? { ok: true as const } : { ok: false as const, error: "Not a decimal amount" }) : { ok: true as const };
  const execErr = clusterMismatch ? `This plan belongs to ${planCluster}; you are on ${settings.cluster}. Switch cluster in Settings to execute it.` : planCluster === null && pool && routeMigrated ? "Migrated v1 plan has no cluster. Assign it to the current cluster first." : !exX.ok ? `X amount: ${exX.error}` : !exY.ok ? `Y amount: ${exY.error}` : !xAmt.trim() && !yAmt.trim() ? "Enter exact token amounts to execute" : !live ? "Waiting for the pool's onchain decimals" : null;

  const width = below + above + 1;
  const widthErr = width > MAX_UI_BINS ? `Route is ${width} bins; cap is ${MAX_UI_BINS}` : null;
  const dist = useMemo(() => (widthErr ? [] : distribute(strategy, 0, -below, above)), [strategy, below, above, widthErr]);
  const budgetNum = Number(budget);
  const budgetErr = !(budgetNum >= 0) ? "Budget must be a positive number" : null;

  // scenario: price moves `shift` bins; share of liquidity in bins at or adjacent to the new active bin
  const covered = Math.abs(shift) <= (shift >= 0 ? above : below);
  const nearShare = dist.filter((b) => Math.abs(b.binId - shift) <= 2).reduce((a, b) => a + (b.x * xShare + b.y * (100 - xShare)) / 100, 0);

  function load(s: SavedRoute) {
    setPool(s.pool); setPoolName(s.poolName ?? ""); setStrategy(s.strategy); setBelow(s.below); setAbove(s.above); setBudget(String(s.illustrative.budget)); setXShare(Math.round(s.illustrative.xShare * 100)); setName(s.name);
    setXAmt(s.exec.x); setYAmt(s.exec.y); setPlanCluster(s.cluster); setRouteMigrated(s.cluster === null);
    if (s.cluster && s.cluster !== settings.cluster) setMsg({ tone: "error", text: `Loaded a ${s.cluster} plan while on ${settings.cluster}. It will not execute here.` });
  }
  function current(): SavedRoute | null {
    if (!isBase58Address(pool)) { setMsg({ tone: "error", text: "Choose a valid pool first." }); return null; }
    if (widthErr || budgetErr) { setMsg({ tone: "error", text: widthErr ?? budgetErr! }); return null; }
    if (!exX.ok || !exY.ok) { setMsg({ tone: "error", text: "Fix the exact token amounts first." }); return null; }
    return { id: uid(), name: name.trim() || "Untitled route", cluster: effCluster, pool, poolName: poolName || undefined, strategy, below, above, exec: { x: xAmt.trim(), y: yAmt.trim(), decX: live?.decX, decY: live?.decY }, illustrative: { budget: budgetNum, xShare: xShare / 100 }, createdAt: Date.now() };
  }
  const shareUrl = (s: SavedRoute) => `${window.location.origin}/app/studio?r=${encodeShare(s)}`;

  const execSplit = (s: SavedRoute) => ({ tab: "add" as const, strategy: s.strategy, below: s.below, above: s.above, x: s.exec.x || undefined, y: s.exec.y || undefined, cluster: s.cluster ?? undefined });

  return (
    <div>
      <PageHead code="ST-02 · Strategy Studio" title="Compose a route." intro="Shape where liquidity rides. Previews and scenarios are simulations; the SDK computes exact amounts when you execute." cap={["simulation", "live"]} />
      {msg && <div className="mb-4"><Notice tone={msg.tone} title={msg.text} action={<Btn size="sm" variant="ghost" onClick={() => setMsg(null)}>Dismiss</Btn>} /></div>}
      <div className="grid gap-6 xl:grid-cols-[1fr_1.4fr]">
        <Panel>
          <h2 className="station-code text-amber">1 · Pool</h2>
          <Field className="mt-3" label="Search live pools or paste an address" value={search} onChange={(e) => { setSearch(e.target.value); if (isBase58Address(e.target.value)) { setPool(e.target.value.trim()); setPoolName(""); setPlanCluster(settings.cluster); setRouteMigrated(false); } }} placeholder="SOL-USDC" />
          {results.data && results.data.data.length > 0 && (
            <ul className="mt-2 max-h-48 overflow-auto border border-line">
              {results.data.data.map((p) => (
                <li key={p.address}><button type="button" className={cn("flex min-h-10 w-full justify-between px-3 text-left text-sm hover:bg-muted", pool === p.address && "bg-muted text-amber")} onClick={() => { setPool(p.address); setPoolName(p.name ?? ""); setPlanCluster("mainnet-beta"); setRouteMigrated(false); }}><span>{p.name}</span><span className="station-code text-cream/60">bin {p.pool_config?.bin_step}</span></button></li>
              ))}
            </ul>
          )}
          {results.isError && <p className="mt-2 text-xs text-destructive">Search failed: {(results.error as Error).message}</p>}
          <p className="mt-2 station-code text-cream/70">Selected: {pool ? `${poolName || "Pool"} · ${shortAddr(pool)}` : "none"}{live ? ` · active #${live.activeId} · ${live.binStep} bps` : pool && snap.isError ? " · onchain read failed" : ""}</p>

          <h2 className="mt-6 station-code text-amber">Plan cluster</h2>
          <p className="mt-2 station-code text-cream/75">{planCluster ?? "unassigned (migrated v1)"}{clusterMismatch ? ` · you are on ${settings.cluster}` : ""}</p>
          {planCluster === null && pool && <Btn size="sm" variant="line" className="mt-2" onClick={() => { setPlanCluster(settings.cluster); setRouteMigrated(false); }}>Assign to {settings.cluster}</Btn>}

          <h2 className="mt-6 station-code text-amber">2 · Template</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button key={t.id} type="button" onClick={() => { setStrategy(t.strategy); setBelow(t.below); setAbove(t.above); }} className="border border-line p-3 text-left hover:border-amber">
                <span className="block font-medium">{t.name}</span><span className="station-code text-cream/60">{t.strategy} · {t.below + t.above + 1} bins</span>
                <span className="mt-1 block text-xs text-cream/70">{t.blurb}</span>
              </button>
            ))}
          </div>

          <h2 className="mt-6 station-code text-amber">3 · Shape</h2>
          <div className="mt-3"><Segmented<StrategyName> label="Strategy" value={strategy} onChange={setStrategy} options={STRATEGIES.map((s) => ({ value: s, label: s }))} /></div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Bins below active" type="number" min={0} max={MAX_UI_BINS} value={below} onChange={(e) => setBelow(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            <Field label="Bins above active" type="number" min={0} max={MAX_UI_BINS} value={above} onChange={(e) => setAbove(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </div>
          {widthErr && <p role="alert" className="mt-2 text-sm text-destructive">{widthErr}</p>}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Illustrative budget (not used for execution)" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} error={budgetErr} />
            <div>
              <label htmlFor="xs" className="station-code text-cream/80">X share {xShare}% / Y {100 - xShare}%</label>
              <input id="xs" type="range" min={0} max={100} value={xShare} onChange={(e) => setXShare(Number(e.target.value))} className="mt-4 w-full accent-[var(--amber)]" />
            </div>
          </div>

          <h2 className="mt-6 station-code text-amber">4 · Exact deposit (used for execution)</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label={`X amount${live ? ` (${live.decX} decimals)` : ""}`} inputMode="decimal" value={xAmt} onChange={(e) => setXAmt(e.target.value)} error={!exX.ok ? exX.error : null} />
            <Field label={`Y amount${live ? ` (${live.decY} decimals)` : ""}`} inputMode="decimal" value={yAmt} onChange={(e) => setYAmt(e.target.value)} error={!exY.ok ? exY.error : null} />
          </div>
          <p className="mt-2 text-xs text-cream/65">Exact token amounts in each token's own units, parsed as integers — carried unchanged into the pool's review. The illustrative budget and split above never become token amounts.</p>
          {pool && execErr && <p className="mt-2 text-sm text-amber">{execErr}</p>}
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel>
            <div className="flex items-center justify-between"><h2 className="display text-2xl">Route preview</h2><Cap kind="simulation" /></div>
            <svg viewBox={`0 0 ${Math.max(1, dist.length) * 12} 140`} preserveAspectRatio="none" className="mt-4 h-48 w-full" role="img" aria-label={`${strategy} allocation across ${width} bins`}>
              {dist.map((b, i) => {
                const val = (b.x * xShare + b.y * (100 - xShare)) / 100;
                const m = Math.max(...dist.map((d) => (d.x * xShare + d.y * (100 - xShare)) / 100)) || 1;
                const h = (val / m) * 120;
                return <rect key={b.binId} x={i * 12 + 1} y={128 - h} width={10} height={h} fill={b.binId === 0 ? "var(--ochre)" : b.binId === shift ? "var(--success)" : b.binId > 0 ? "var(--amber)" : "var(--cream)"}><title>{`Bin ${b.binId >= 0 ? "+" : ""}${b.binId}: ${(val * 100).toFixed(2)}% of budget`}</title></rect>;
              })}
              <line x1={0} x2={dist.length * 12} y1={134} y2={134} stroke="var(--cream)" strokeDasharray="6 4" strokeOpacity={0.6} />
            </svg>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Width" value={`${width} bins`} sub={live ? `${fmtPct(pctMoveBetweenBins(0, -below, live.binStep))} / +${fmtPct(pctMoveBetweenBins(0, above, live.binStep))}` : "needs pool bin step"} />
              <Stat label="Covers active" value={below >= 0 && above >= 0 ? "Yes" : "No"} />
              <Stat label="Low price" value={live ? fmtNum(uiPriceFromBin(live.activeId - below, live.binStep, live.decX, live.decY), 6) : "—"} />
              <Stat label="High price" value={live ? fmtNum(uiPriceFromBin(live.activeId + above, live.binStep, live.decX, live.decY), 6) : "—"} />
            </div>
            <div className="mt-6 border-t border-line pt-4">
              <label htmlFor="shift" className="station-code">Scenario: price moves {shift >= 0 ? "+" : ""}{shift} bins {live ? `(${fmtPct(pctMoveBetweenBins(0, shift, live.binStep))})` : ""}</label>
              <input id="shift" type="range" min={-80} max={80} value={shift} onChange={(e) => setShift(Number(e.target.value))} className="mt-2 w-full accent-[var(--amber)]" />
              <p className="mt-2 text-sm text-cream/80">
                {covered ? `Still in range. ~${(nearShare * 100).toFixed(1)}% of the illustrative allocation sits within 2 bins of the new active bin.` : "Out of range: this position would stop earning swap fees and be fully converted to one token."}
              </p>
              <p className="mt-1 text-xs text-cream/60">Simulation of shape only. No fee or return estimate is implied.</p>
            </div>
          </Panel>

          <Panel tone="cobalt">
            <h2 className="station-code text-amber">4 · Save, share, execute</h2>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field className="flex-1" label="Route name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <Btn onClick={() => { const c = current(); if (c) { setRoutes((rs) => [c, ...rs]); setMsg({ tone: "info", text: `Saved “${c.name}” in this browser.` }); } }}>Save route</Btn>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn size="sm" variant="line" onClick={async () => { const c = current(); if (!c) return; try { await navigator.clipboard.writeText(shareUrl(c)); setMsg({ tone: "info", text: "Share link copied to clipboard." }); } catch { setMsg({ tone: "error", text: shareUrl(c) }); } }}>Copy share link</Btn>
              <Btn size="sm" variant="line" disabled={!routes.length} onClick={() => { const b = new Blob([exportRoutes(routes)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "studio-loco-routes.json"; a.click(); URL.revokeObjectURL(a.href); }}>Export JSON</Btn>
              <Btn size="sm" variant="line" onClick={() => fileRef.current?.click()}>Import JSON</Btn>
              <input ref={fileRef} type="file" accept="application/json" className="hidden" aria-label="Import routes file" onChange={async (e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const res = importRoutes(await f.text());
                if (res.ok) { setRoutes((rs) => [...res.routes.map((x) => ({ ...x, id: uid() })), ...rs]); setMsg({ tone: "info", text: `Imported ${res.routes.length} route(s)${res.migrated ? ` — ${res.migrated} migrated from v1 without a cluster; assign one before executing` : ""}.` }); } else setMsg({ tone: "error", text: `Import rejected: ${res.error}` });
                e.target.value = "";
              }} />
              {isBase58Address(pool) && !widthErr && !execErr && <Link to="/app/pool/$address" params={{ address: pool }} search={{ tab: "add", strategy, below, above, x: xAmt.trim() || undefined, y: yAmt.trim() || undefined, cluster: effCluster }} className="station-code inline-flex min-h-9 items-center bg-amber px-3 text-midnight">Execute this route →</Link>}
            </div>
          </Panel>
        </div>
      </div>

      <section className="mt-10">
        <h2 className="display text-3xl">Saved routes</h2>
        <p className="mt-1 text-sm text-cream/70">Multi-route plans execute one route at a time, each with its own review and wallet approval. A failed step does not undo earlier confirmed ones.</p>
        {routes.length === 0 ? <p className="mt-4 text-cream/70">No saved routes yet.</p> : (
          <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {routes.map((s, i) => (
              <li key={s.id} className="ticket p-4">
                <p className="station-code text-amber">Stop {i + 1} · {s.strategy}</p>
                <p className="mt-1 font-medium">{s.name}</p>
                <p className="station-code mt-1 text-cream/60">{s.poolName || shortAddr(s.pool)} · −{s.below}/+{s.above} bins · {s.cluster ?? "no cluster (v1)"}</p>
                <p className="station-code mt-1 text-cream/60">Exact: {s.exec.x || "0"} X · {s.exec.y || "0"} Y</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn size="sm" variant="quiet" onClick={() => load(s)}>Load</Btn>
                  <Btn size="sm" variant="line" onClick={() => setRoutes((rs) => [{ ...s, id: uid(), name: `${s.name} copy`.slice(0, 60), createdAt: Date.now() }, ...rs])}>Duplicate</Btn>
                  <Btn size="sm" variant="danger" onClick={() => setRoutes((rs) => rs.filter((x) => x.id !== s.id))}>Delete</Btn>
                  {s.cluster === settings.cluster && (s.exec.x || s.exec.y) ? <Link to="/app/pool/$address" params={{ address: s.pool }} search={execSplit(s)} className="station-code inline-flex min-h-9 items-center text-amber underline">Execute →</Link> : <span className="station-code inline-flex min-h-9 items-center text-cream/55">{s.cluster !== settings.cluster ? "Other cluster" : "Needs exact amounts"}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

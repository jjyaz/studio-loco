import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import BN from "bn.js";
import type { Keypair, Transaction } from "@solana/web3.js";
import { Btn, Cap, Field, Notice, Panel, Segmented, Spinner, Stat, Eyebrow } from "@/components/kit";
import { PriceHistory } from "@/components/app/PriceHistory";
import { RailMap } from "@/components/app/RailMap";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { useBalance, usePoolSdk, usePoolSnapshot, type PoolSnapshot } from "@/components/app/pool-hooks";
import { WalletButton } from "@/components/wallet/WalletButton";
import { fetchPool, v24 } from "@/lib/meteora-api";
import { formatUnits, parseUnits } from "@/lib/amount";
import { uiPriceFromBin, binFromUiPrice, pctMoveBetweenBins } from "@/lib/bins";
import { DASH, explorerAccount, fmtNum, fmtPct, fmtUsd, isBase58Address, shortAddr, timeAgo } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { MAX_UI_BINS, STRATEGIES, STRATEGY_TYPE_VALUE, distribute, type StrategyName } from "@/lib/strategy";
import { useSettings, useStars } from "@/lib/settings";
import { loadSdk, poolSupportsLimitOrders } from "@/lib/dlmm";
import { discoverOrders } from "@/components/app/orders";
import { planKey, usePlan } from "@/lib/plan";
import { splitAmount } from "@/lib/derive";
import { simulateExact } from "@/lib/tx";
import { spendable, WSOL_MINT, SOL_RESERVE_LAMPORTS } from "@/lib/chain";
import { cn } from "@/lib/utils";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

const search = z.object({
  tab: z.enum(["overview", "add", "swap", "orders"]).optional().catch(undefined),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]).optional().catch(undefined),
  below: z.number().int().min(0).max(MAX_UI_BINS).optional().catch(undefined),
  above: z.number().int().min(0).max(MAX_UI_BINS).optional().catch(undefined),
  x: z.string().max(40).optional().catch(undefined),
  y: z.string().max(40).optional().catch(undefined),
  /** cluster a Studio plan was built for; mismatches block review */
  cluster: z.enum(["mainnet-beta", "devnet"]).optional().catch(undefined),
});

export const Route = createFileRoute("/app/pool/$address")({
  validateSearch: zodValidator(search),
  head: ({ params }) => ({
    meta: [
      { title: `Pool ${params.address.slice(0, 6)}… — Studio Loco` },
      { name: "description", content: "Meteora DLMM pool: live metrics, rail map of real bins, add liquidity and direct swaps." },
      { property: "og:title", content: "DLMM pool — Studio Loco" },
      { property: "og:description", content: "Live DLMM pool metrics, bins, swaps and liquidity." },
    ],
  }),
  component: PoolPage,
});

function PoolPage() {
  const { address } = Route.useParams();
  const s = Route.useSearch();
  const navigate = Route.useNavigate();
  const { settings } = useSettings();
  const stars = useStars();
  const tab = s.tab ?? (s.strategy ? "add" : "overview");
  const valid = isBase58Address(address);

  const api = useQuery({
    queryKey: ["api-pool", address],
    queryFn: ({ signal }) => fetchPool(address, signal),
    enabled: valid && settings.cluster === "mainnet-beta",
    retry: 1,
    refetchInterval: 60_000,
  });
  const sdk = usePoolSdk(address);
  const snap = usePoolSnapshot(address);

  if (!valid) return <Notice tone="error" title="Invalid pool address">“{address}” is not a Solana address. <Link to="/app" className="underline">Back to terminal</Link></Notice>;

  const symX = api.data?.token_x?.symbol ?? (snap.data ? shortAddr(snap.data.mintX) : "X");
  const symY = api.data?.token_y?.symbol ?? (snap.data ? shortAddr(snap.data.mintY) : "Y");

  return (
    <div>
      <div className="relative mb-8 overflow-hidden">
        <img src={nightAsset.url} alt="" aria-hidden className="pixelated absolute inset-0 h-full w-full object-cover object-[70%_60%]" />
        <div className="relative flex flex-col gap-4 bg-midnight/60 p-6 md:flex-row md:items-end md:justify-between md:p-8">
          <div>
            <Eyebrow>Pool · {shortAddr(address, 6)}</Eyebrow>
            <h1 className="display mt-2 text-4xl text-cream md:text-6xl">{api.data?.name ?? `${symX}-${symY}`}</h1>
            <div className="mt-3 flex flex-wrap gap-2">
              <Cap kind="live" />
              {api.data?.is_blacklisted && <span className="station-code border border-destructive px-2 py-1 text-destructive">Blacklisted</span>}
              <a className="station-code border border-line px-2 py-1 hover:text-amber" href={explorerAccount(address, settings.cluster)} target="_blank" rel="noreferrer">Explorer ↗</a>
            </div>
          </div>
          <Btn variant="line" size="sm" onClick={() => stars.toggle(address)} aria-pressed={stars.isStarred(address)}>
            {stars.isStarred(address) ? "★ Starred" : "☆ Star pool"}
          </Btn>
        </div>
      </div>

      <div role="tablist" aria-label="Pool sections" className="mb-6 flex flex-wrap border-b border-line">
        {(["overview", "add", "swap", "orders"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => navigate({ to: ".", search: (p) => ({ ...p, tab: t }) })} className={cn("station-code min-h-11 border-b-2 px-4", tab === t ? "border-amber text-amber" : "border-transparent text-cream/75 hover:text-cream")}>
            {t === "add" ? "Add Liquidity" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {(sdk.isError || snap.isError) && (
        <Notice tone="error" title="Couldn't read this pool from your RPC" action={<Btn size="sm" onClick={() => { sdk.refetch(); snap.refetch(); }}>Retry</Btn>}>
          {redactUrls(String(((sdk.error ?? snap.error) as Error)?.message ?? ""))}. Check the cluster and RPC endpoint in Settings. The public RPC is rate-limited.
        </Notice>
      )}

      {tab === "overview" && <Overview address={address} api={api} snap={snap.data} snapLoading={snap.isPending && !sdk.isError} symX={symX} symY={symY} updatedAt={snap.dataUpdatedAt} cluster={settings.cluster} />}
      {tab === "add" && (snap.data ? <AddLiquidity address={address} snap={snap.data} symX={symX} symY={symY} prefill={s} /> : !sdk.isError && <Spinner label="Loading pool bins" />)}
      {tab === "swap" && (snap.data ? <Swap address={address} snap={snap.data} symX={symX} symY={symY} /> : !sdk.isError && <Spinner label="Loading pool" />)}
      {tab === "orders" && (snap.data ? <Orders address={address} snap={snap.data} symX={symX} symY={symY} /> : !sdk.isError && <Spinner label="Reading pool mode" />)}
    </div>
  );
}

function Overview({ address, api, snap, snapLoading, symX, symY, updatedAt, cluster }: { cluster: import("@/lib/settings").Cluster; address: string; api: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchPool>>>>; snap?: PoolSnapshot; snapLoading: boolean; symX: string; symY: string; updatedAt: number }) {
  const p = api.data;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
      <Panel>
        <div className="flex items-center justify-between">
          <h2 className="display text-2xl">Rail Map</h2>
          <span className="station-code text-cream/60">{updatedAt ? `Bins ${timeAgo(updatedAt)}` : DASH}</span>
        </div>
        <p className="mt-1 text-sm text-cream/70">80 real bins around the active bin, read with the official SDK from your RPC.</p>
        <div className="mt-5">
          {snap ? <RailMap bins={snap.bins} activeId={snap.activeId} decX={snap.decX} decY={snap.decY} symX={symX} symY={symY} /> : snapLoading ? <Spinner label="Reading bins" /> : <p className="text-sm text-cream/70">Bins unavailable.</p>}
        </div>
      </Panel>
      <Panel className="lg:col-span-2">
        {cluster === "mainnet-beta"
          ? <PriceHistory address={address} symX={symX} symY={symY} currentPrice={p?.current_price} />
          : <p className="text-sm text-cream/75">Price history comes from Meteora's mainnet index, so it isn't shown on devnet.</p>}
      </Panel>
      <div className="flex flex-col gap-6">
        <Panel tone="cobalt">
          <h2 className="station-code text-amber">Market · Meteora API</h2>
          {api.isError && <p className="mt-2 text-sm text-destructive">API data unavailable: {redactUrls(String(((api.error) as Error)?.message ?? ""))}</p>}
          {!api.isEnabled && <p className="mt-2 text-sm text-cream/70">API metrics are mainnet-only.</p>}
          <div className="mt-4 grid grid-cols-2 gap-5">
            <Stat label="TVL" value={fmtUsd(p?.tvl)} />
            <Stat label="Volume 24h" value={fmtUsd(v24(p?.volume))} />
            <Stat label="Fees 24h" value={fmtUsd(v24(p?.fees))} />
            <Stat label="Fee/TVL 24h" value={fmtPct(v24(p?.fee_tvl_ratio), 4)} />
            <Stat label="Base fee" value={fmtPct(p?.pool_config?.base_fee_pct)} />
            <Stat label="Dynamic fee" value={fmtPct(p?.dynamic_fee_pct)} />
          </div>
        </Panel>
        <Panel>
          <h2 className="station-code text-amber">Onchain · your RPC</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-cream/65">Active bin</dt><dd className="font-mono tabular">{snap?.activeId ?? DASH}</dd>
            <dt className="text-cream/65">Price</dt><dd className="font-mono tabular">{snap ? `${fmtNum(snap.activePrice, 6)} ${symY}/${symX}` : DASH}</dd>
            <dt className="text-cream/65">Bin step</dt><dd className="font-mono tabular">{snap ? `${snap.binStep} bps` : DASH}</dd>
            <dt className="text-cream/65">Token X</dt><dd className="font-mono">{snap ? <a className="underline" href={explorerAccount(snap.mintX, cluster)} target="_blank" rel="noreferrer">{symX} · {snap.decX}d</a> : DASH}</dd>
            <dt className="text-cream/65">Token Y</dt><dd className="font-mono">{snap ? <a className="underline" href={explorerAccount(snap.mintY, cluster)} target="_blank" rel="noreferrer">{symY} · {snap.decY}d</a> : DASH}</dd>
            <dt className="text-cream/65">Reserve X</dt><dd className="font-mono tabular">{snap ? formatUnits(snap.reserveX, snap.decX, 4) : DASH}</dd>
            <dt className="text-cream/65">Reserve Y</dt><dd className="font-mono tabular">{snap ? formatUnits(snap.reserveY, snap.decY, 4) : DASH}</dd>
            <dt className="text-cream/65">Function mode</dt><dd className="font-mono">{snap ? fnName(snap.functionType) : DASH}</dd>
          </dl>
          <p className="mt-4 text-xs text-cream/60">Token X is the base; prices are quoted in {symY} per {symX}. Pool {shortAddr(address)}.</p>
        </Panel>
      </div>
    </div>
  );
}

const fnName = (f?: number) => (f === 1 ? "Liquidity Mining" : f === 2 ? "Limit Order" : f === 0 ? "Undetermined" : DASH);

/* ------------------------------ shared helpers ------------------------------ */

function usePlanContext(address: string) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { settings } = useSettings();
  return { wallet: publicKey?.toBase58(), cluster: settings.cluster, rpc: connection.rpcEndpoint, pool: address, slippage: settings.slippageBps };
}

/** Balance + native SOL reserve check. Returns an error string, or null when the amount is affordable. */
function affordability(mint: string, need: BN, bal: BN | undefined, sym: string): string | null {
  if (!bal) return null;
  if (mint === WSOL_MINT) {
    if (need.add(SOL_RESERVE_LAMPORTS).gt(bal)) return `${sym}: keep ~${formatUnits(SOL_RESERVE_LAMPORTS, 9)} SOL for fees and rent — reduce the amount`;
    return null;
  }
  return need.gt(bal) ? `${sym} amount exceeds your balance` : null;
}

function simText(sim: { value: { err: unknown; logs: string[] | null } }) {
  return sim.value.err ? `${JSON.stringify(sim.value.err)} — ${(sim.value.logs ?? []).slice(-3).join(" | ")}` : null;
}

/* ------------------------------ Add liquidity ------------------------------ */

function AddLiquidity({ address, snap, symX, symY, prefill }: { address: string; snap: PoolSnapshot; symX: string; symY: string; prefill: z.infer<typeof search> }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { settings } = useSettings();
  const sdk = usePoolSdk(address);
  const qc = useQueryClient();
  const ctxKey = usePlanContext(address);
  const [strategy, setStrategy] = useState<StrategyName>(prefill.strategy ?? "Spot");
  const [mode, setMode] = useState<"bins" | "price">("bins");
  const [below, setBelow] = useState(String(prefill.below ?? 10));
  const [above, setAbove] = useState(String(prefill.above ?? 10));
  const [minP, setMinP] = useState("");
  const [maxP, setMaxP] = useState("");
  const [xAmt, setXAmt] = useState(prefill.x ?? "");
  const [yAmt, setYAmt] = useState(prefill.y ?? "");
  const [prepErr, setPrepErr] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const runner = useTxRunner();
  const balX = useBalance(publicKey, snap.mintX);
  const balY = useBalance(publicKey, snap.mintY);

  const { minBin, maxBin, rangeErr } = useMemo(() => {
    if (mode === "bins") {
      const b = Number(below), a = Number(above);
      if (!Number.isInteger(b) || !Number.isInteger(a) || b < 0 || a < 0) return { minBin: NaN, maxBin: NaN, rangeErr: "Bins must be whole numbers ≥ 0" };
      return { minBin: snap.activeId - b, maxBin: snap.activeId + a, rangeErr: null };
    }
    const lo = binFromUiPrice(Number(minP), snap.binStep, snap.decX, snap.decY, "floor");
    const hi = binFromUiPrice(Number(maxP), snap.binStep, snap.decX, snap.decY, "ceil");
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { minBin: NaN, maxBin: NaN, rangeErr: "Enter positive min and max prices" };
    if (lo > hi) return { minBin: NaN, maxBin: NaN, rangeErr: "Min price must be below max price" };
    return { minBin: lo, maxBin: hi, rangeErr: null };
  }, [mode, below, above, minP, maxP, snap.activeId, snap.binStep, snap.decX, snap.decY]);

  const width = maxBin - minBin + 1;
  const widthErr = !rangeErr && width > MAX_UI_BINS ? `Range is ${width} bins; this interface caps new positions at ${MAX_UI_BINS} bins` : null;
  const px = xAmt.trim() ? parseUnits(xAmt, snap.decX) : { ok: true as const, raw: new BN(0) };
  const py = yAmt.trim() ? parseUnits(yAmt, snap.decY) : { ok: true as const, raw: new BN(0) };
  const xRaw = px.ok ? px.raw : null;
  const yRaw = py.ok ? py.raw : null;
  const onlyAbove = minBin > snap.activeId;
  const onlyBelow = maxBin < snap.activeId;
  let amtErr: string | null = null;
  if (!px.ok) amtErr = `${symX}: ${px.error}`;
  else if (!py.ok) amtErr = `${symY}: ${py.error}`;
  else if (xRaw!.isZero() && yRaw!.isZero()) amtErr = "Enter an amount for at least one token";
  else if (onlyAbove && !yRaw!.isZero()) amtErr = `Range is entirely above the active bin — it can only hold ${symX}. Set ${symY} to 0.`;
  else if (onlyBelow && !xRaw!.isZero()) amtErr = `Range is entirely below the active bin — it can only hold ${symY}. Set ${symX} to 0.`;
  else amtErr = affordability(snap.mintX, xRaw!, balX.data, symX) ?? affordability(snap.mintY, yRaw!, balY.data, symY);

  const preview = !rangeErr && !widthErr ? distribute(strategy, snap.activeId, minBin, maxBin) : [];
  const balancesReady = !!balX.data && !!balY.data;
  const clusterBlock = prefill.cluster && prefill.cluster !== settings.cluster ? `This plan was built for ${prefill.cluster}; you are on ${settings.cluster}. Switch cluster in Settings — it will not execute here.` : null;
  const canReview = !clusterBlock && !!publicKey && !rangeErr && !widthErr && !amtErr && !!sdk.data && balancesReady;

  type CostQuote = { positionCost: number; positionReallocCost: number; bitmapExtensionCost: number; binArraysCount: number; binArrayCost: number } | null;
  type Review = { tx: Transaction; signer: Keypair; feeLamports: number | null; rentLamports: number; cost: CostQuote; position: string; sim: string | null; strategy: StrategyName; minBin: number; maxBin: number; x: BN; y: BN; slippageBps: number; activeId: number };
  const liveKey = planKey({ ...ctxKey, strategy, minBin, maxBin, x: xRaw?.toString(), y: yRaw?.toString() });
  const { plan: review, begin, clear } = usePlan<Review>(liveKey);

  async function prepare() {
    if (!sdk.data || !publicKey || !xRaw || !yRaw || preparing) return;
    const job = begin();
    setPreparing(true);
    setPrepErr(null);
    try {
      const { Keypair } = await import("@solana/web3.js");
      const sdkMod = await loadSdk();
      const positionKp = Keypair.generate(); // ephemeral: lives only inside this in-memory plan; never persisted or logged
      await sdk.data.refetchStates();
      const slippageBps = settings.slippageBps;
      const tx = await sdk.data.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        totalXAmount: xRaw, // base units (BN), per SDK types
        totalYAmount: yRaw,
        strategy: { minBinId: minBin, maxBinId: maxBin, strategyType: STRATEGY_TYPE_VALUE[strategy] },
        user: publicKey,
        slippage: slippageBps / 100,
      });
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const msg = tx.serializeMessage();
      const [fee, rent, sim, cost] = await Promise.all([
        connection.getFeeForMessage(tx.compileMessage(), "confirmed").then((r) => r.value).catch(() => null),
        connection.getMinimumBalanceForRentExemption(sdkMod.POSITION_MIN_SIZE),
        simulateExact(connection, msg),
        // SDK quote (values in SOL): position, realloc, bitmap-extension and new bin-array rent. Null if the SDK call fails.
        sdk.data.quoteCreatePosition({ strategy: { minBinId: minBin, maxBinId: maxBin, strategyType: STRATEGY_TYPE_VALUE[strategy] } }).catch(() => null),
      ]);
      job.commit({ tx, signer: positionKp, feeLamports: fee, rentLamports: rent, cost, position: positionKp.publicKey.toBase58(), sim: simText(sim), strategy, minBin, maxBin, x: xRaw, y: yRaw, slippageBps, activeId: snap.activeId });
    } catch (e) {
      if (job.isCurrent()) setPrepErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      setPreparing(false);
    }
  }

  async function execute() {
    if (!review || runner.running) return;
    const r = review;
    const res = await runner.run([{ label: "Create position and add liquidity", tx: r.tx, signers: [r.signer] }]);
    clear(); // drop the plan (and the ephemeral key with it) whatever the outcome
    if (res.length && res.every((x) => x.phase === "confirmed")) {
      qc.invalidateQueries({ queryKey: ["bal"] });
      qc.invalidateQueries({ queryKey: ["dlmm-snap"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
    }
  }

  const lowPrice = Number.isFinite(minBin) ? uiPriceFromBin(minBin, snap.binStep, snap.decX, snap.decY) : NaN;
  const highPrice = Number.isFinite(maxBin) ? uiPriceFromBin(maxBin, snap.binStep, snap.decX, snap.decY) : NaN;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <Panel>
        <h2 className="display text-2xl">Add liquidity</h2>
        <div className="mt-5 flex flex-col gap-5">
          <div>
            <p className="station-code mb-2 text-cream/80">Strategy</p>
            <Segmented<StrategyName> label="Strategy" value={strategy} onChange={setStrategy} options={STRATEGIES.map((v) => ({ value: v, label: v }))} />
          </div>
          <div>
            <p className="station-code mb-2 text-cream/80">Range by</p>
            <Segmented label="Range mode" value={mode} onChange={(m) => { setMode(m); if (m === "price" && Number.isFinite(lowPrice)) { setMinP(String(lowPrice)); setMaxP(String(highPrice)); } }} options={[{ value: "bins", label: "Bins around active" }, { value: "price", label: "Price" }]} />
          </div>
          {mode === "bins" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bins below" inputMode="numeric" value={below} onChange={(e) => setBelow(e.target.value)} />
              <Field label="Bins above" inputMode="numeric" value={above} onChange={(e) => setAbove(e.target.value)} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Min price (${symY}/${symX})`} inputMode="decimal" value={minP} onChange={(e) => setMinP(e.target.value)} />
              <Field label={`Max price (${symY}/${symX})`} inputMode="decimal" value={maxP} onChange={(e) => setMaxP(e.target.value)} />
            </div>
          )}
          {(rangeErr || widthErr) && <p role="alert" className="text-sm text-destructive">{rangeErr ?? widthErr}</p>}
          {!rangeErr && (
            <p className="station-code break-words text-cream/75">
              Bins {minBin} → {maxBin} · {width} bins · {fmtNum(lowPrice, 6)} – {fmtNum(highPrice, 6)} ({fmtPct(pctMoveBetweenBins(snap.activeId, minBin, snap.binStep))} / +{fmtPct(pctMoveBetweenBins(snap.activeId, maxBin, snap.binStep))})
            </p>
          )}
          <Field label={`${symX} amount`} inputMode="decimal" value={xAmt} onChange={(e) => setXAmt(e.target.value)} hint={publicKey ? <BalanceHint q={balX} mint={snap.mintX} dec={snap.decX} sym={symX} onMax={(v) => setXAmt(v)} /> : undefined} disabled={onlyBelow} />
          <Field label={`${symY} amount`} inputMode="decimal" value={yAmt} onChange={(e) => setYAmt(e.target.value)} hint={publicKey ? <BalanceHint q={balY} mint={snap.mintY} dec={snap.decY} sym={symY} onMax={(v) => setYAmt(v)} /> : undefined} disabled={onlyAbove} />
          {amtErr && (xAmt || yAmt) && <p role="alert" className="text-sm text-destructive">{amtErr}</p>}
          {publicKey && !balancesReady && <p className="text-xs text-cream/70">{balX.isError || balY.isError ? "Balance check failed — review is disabled until balances can be read." : "Checking balances before review…"}</p>}
          {clusterBlock && <Notice tone="error" title="Wrong cluster for this plan">{clusterBlock}</Notice>}
          {!publicKey ? <WalletButton /> : <Btn onClick={prepare} disabled={!canReview || preparing}>{preparing ? "Building with SDK…" : "Review transaction"}</Btn>}
          {prepErr && <Notice tone="error" title="Couldn't build the transaction">{prepErr}</Notice>}
        </div>
      </Panel>
      <div className="flex flex-col gap-6">
        <Panel>
          <div className="flex items-center justify-between"><h3 className="station-code text-amber">Range on the rail</h3><Cap kind="live" /></div>
          <div className="mt-4"><RailMap bins={snap.bins} activeId={snap.activeId} decX={snap.decX} decY={snap.decY} symX={symX} symY={symY} range={Number.isFinite(minBin) ? [minBin, maxBin] : undefined} /></div>
          {preview.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between"><p className="station-code text-cream/80">{strategy} shape preview</p><Cap kind="simulation" /></div>
              <svg viewBox={`0 0 ${preview.length * 10} 60`} className="mt-2 h-16 w-full" preserveAspectRatio="none" aria-label="Illustrative strategy distribution">
                {preview.map((b, i) => { const m = Math.max(...preview.map((p) => Math.max(p.x, p.y))) || 1; const h = (Math.max(b.x, b.y) / m) * 58; return <rect key={b.binId} x={i * 10 + 1} y={60 - h} width={8} height={h} fill={b.binId === snap.activeId ? "var(--ochre)" : b.binId > snap.activeId ? "var(--amber)" : "var(--cream)"} />; })}
              </svg>
              <p className="mt-1 text-xs text-cream/60">Illustrative. The SDK computes exact per-bin amounts for the transaction.</p>
            </div>
          )}
        </Panel>
        {review && (
          <Panel tone="cobalt">
            <h3 className="display text-2xl">Review</h3>
            <p className="station-code mt-1 text-cream/65">Frozen plan · changes to the form discard it</p>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/70">Pool</dt><dd className="font-mono">{shortAddr(address, 6)}</dd>
              <dt className="text-cream/70">Strategy</dt><dd>{review.strategy}</dd>
              <dt className="text-cream/70">Bins</dt><dd className="font-mono">{review.minBin} → {review.maxBin} ({review.maxBin - review.minBin + 1}) · active {review.activeId}</dd>
              <dt className="text-cream/70">Deposit {symX}</dt><dd className="break-all font-mono">{formatUnits(review.x, snap.decX)}</dd>
              <dt className="text-cream/70">Deposit {symY}</dt><dd className="break-all font-mono">{formatUnits(review.y, snap.decY)}</dd>
              <dt className="text-cream/70">Slippage</dt><dd className="font-mono">{review.slippageBps / 100}%</dd>
              <dt className="text-cream/70">Network fee</dt><dd className="font-mono">{review.feeLamports !== null ? `${formatUnits(String(review.feeLamports), 9)} SOL` : DASH}</dd>
              <dt className="text-cream/70">Position rent</dt><dd className="font-mono">~{formatUnits(String(review.rentLamports), 9, 5)} SOL (refundable on close)</dd>
              <dt className="text-cream/70">New position</dt><dd className="font-mono">{shortAddr(review.position, 6)}</dd>
            </dl>
            {review.cost ? (
              <dl className="mt-3 grid grid-cols-2 gap-y-1 border-t border-cream/20 pt-3 text-xs">
                <dt className="text-cream/70">SDK estimate · position</dt><dd className="font-mono">{fmtNum(review.cost.positionCost + review.cost.positionReallocCost, 6)} SOL</dd>
                <dt className="text-cream/70">New bin arrays ({review.cost.binArraysCount})</dt><dd className="font-mono">{fmtNum(review.cost.binArrayCost, 6)} SOL (not refundable)</dd>
                <dt className="text-cream/70">Bitmap extension</dt><dd className="font-mono">{fmtNum(review.cost.bitmapExtensionCost, 6)} SOL</dd>
                <dt className="text-cream/70">Estimated total + network fee</dt><dd className="font-mono">{review.feeLamports !== null ? `${fmtNum(review.cost.positionCost + review.cost.positionReallocCost + review.cost.binArrayCost + review.cost.bitmapExtensionCost + review.feeLamports / 1e9, 6)} SOL` : DASH}</dd>
              </dl>
            ) : <p className="mt-3 text-xs text-cream/70">Full cost estimate unavailable — {DASH}.</p>}
            <p className="mt-2 text-xs text-cream/70">Estimates exclude any new token-account rent (~0.002 SOL each). The exact simulation above checks you can afford it; the wallet preview shows the final amount.</p>
            {review.sim ? <Notice tone="error" title="Simulation failed — not sent">{review.sim}</Notice> : <p className="mt-3 station-code text-success">Exact message simulation passed</p>}
            <Btn className="mt-4 w-full" onClick={execute} disabled={!!review.sim || runner.running}>{runner.running ? "Working…" : "Sign & send with wallet"}</Btn>
          </Panel>
        )}
        <TxSteps steps={runner.steps} />
      </div>
    </div>
  );
}

function BalanceHint({ q, mint, dec, sym, onMax }: { q: ReturnType<typeof useBalance>; mint: string; dec: number; sym: string; onMax: (v: string) => void }) {
  if (q.isPending) return <>Reading balance…</>;
  if (q.isError) return <span className="text-destructive">Balance unavailable ({redactUrls((q.error as Error).message).slice(0, 60)})</span>;
  const max = spendable(mint, q.data!);
  const v = formatUnits(max, dec).replace(/,/g, "");
  return (
    <>Balance {formatUnits(q.data!, dec, 6)} {sym} · <button type="button" className="underline" onClick={() => onMax(v)} disabled={max.isZero()}>Max</button>{mint === WSOL_MINT && " (keeps 0.05 SOL back — new positions can cost more; check the review)"}</>
  );
}

/* ---------------------------------- Swap ---------------------------------- */

const QUOTE_TTL = 20_000;

function Swap({ address, snap, symX, symY }: { address: string; snap: PoolSnapshot; symX: string; symY: string }) {
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const sdk = usePoolSdk(address);
  const qc = useQueryClient();
  const runner = useTxRunner();
  const ctxKey = usePlanContext(address);
  const [xToY, setXToY] = useState(true);
  const [amt, setAmt] = useState("");
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const inDec = xToY ? snap.decX : snap.decY;
  const outDec = xToY ? snap.decY : snap.decX;
  const inSym = xToY ? symX : symY;
  const outSym = xToY ? symY : symX;
  const inMint = xToY ? snap.mintX : snap.mintY;
  const bal = useBalance(publicKey, inMint);
  const parsed = amt.trim() ? parseUnits(amt, inDec) : null;
  const inputErr = parsed && !parsed.ok ? parsed.error : parsed?.ok && parsed.raw.isZero() ? "Amount must be greater than 0" : parsed?.ok ? affordability(inMint, parsed.raw, bal.data, inSym) : null;

  type Quote = { at: number; xToY: boolean; requested: BN; inRaw: BN; out: BN; min: BN; fee: BN; impact: string; binArrays: import("@solana/web3.js").PublicKey[]; slippageBps: number; inSym: string; outSym: string; inDec: number; outDec: number };
  const liveKey = planKey({ ...ctxKey, xToY, amt: parsed?.ok ? parsed.raw.toString() : amt });
  const { plan: quote, begin, clear } = usePlan<Quote>(liveKey);
  const expired = quote ? now - quote.at > QUOTE_TTL : false;
  const ready = !!publicKey ? !!bal.data : true;

  async function getQuote() {
    if (!sdk.data || !parsed?.ok || busy) return;
    const job = begin();
    setBusy(true);
    setQErr(null);
    try {
      await sdk.data.refetchStates();
      const arrays = await sdk.data.getBinArrayForSwap(xToY, 4);
      const slippageBps = settings.slippageBps;
      const q = sdk.data.swapQuote(parsed.raw, xToY, new BN(slippageBps), arrays);
      job.commit({ at: Date.now(), xToY, requested: parsed.raw, inRaw: q.consumedInAmount, out: q.outAmount, min: q.minOutAmount, fee: q.fee, impact: q.priceImpact.toString(), binArrays: q.binArraysPubkey, slippageBps, inSym, outSym, inDec, outDec });
    } catch (e) {
      if (job.isCurrent()) setQErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function doSwap() {
    if (!sdk.data || !publicKey || !quote || expired || busy || runner.running) return;
    const q = quote;
    setBusy(true);
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await sdk.data.swap({
        inToken: new PublicKey(q.xToY ? snap.mintX : snap.mintY),
        outToken: new PublicKey(q.xToY ? snap.mintY : snap.mintX),
        inAmount: q.inRaw,
        minOutAmount: q.min,
        lbPair: sdk.data.pubkey,
        user: publicKey,
        binArraysPubkey: q.binArrays,
      });
      const res = await runner.run([{ label: `Swap ${q.inSym} → ${q.outSym}`, tx }]);
      clear();
      if (res.length && res.every((r) => r.phase === "confirmed")) {
        setAmt("");
        qc.invalidateQueries({ queryKey: ["bal"] });
        qc.invalidateQueries({ queryKey: ["dlmm-snap"] });
      }
    } catch (e) {
      setQErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel>
        <h2 className="display text-2xl">Direct pool swap</h2>
        <p className="mt-1 text-sm text-cream/70">Trades against this DLMM pool only, not an aggregator route.</p>
        <div className="mt-5 flex flex-col gap-4">
          <Field label={`You pay (${inSym})`} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} error={amt ? inputErr : null} hint={publicKey ? <BalanceHint q={bal} mint={inMint} dec={inDec} sym={inSym} onMax={setAmt} /> : undefined} />
          <Btn variant="line" size="sm" onClick={() => setXToY((v) => !v)} aria-label="Reverse swap direction">⇅ Reverse: {inSym} → {outSym}</Btn>
          <Btn variant="quiet" onClick={getQuote} disabled={!parsed?.ok || !!inputErr || busy || !sdk.data || !ready}>{busy && !quote ? "Quoting…" : quote ? "Refresh quote" : "Get quote"}</Btn>
          {qErr && <Notice tone="error" title="Quote or swap failed">{qErr}</Notice>}
        </div>
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel tone="cobalt">
          <h3 className="station-code text-amber">Quote · SDK</h3>
          {quote ? (
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/70">Input used</dt><dd className="break-all font-mono">{formatUnits(quote.inRaw, quote.inDec)} {quote.inSym}</dd>
              <dt className="text-cream/70">Expected out</dt><dd className="break-all font-mono">{formatUnits(quote.out, quote.outDec)} {quote.outSym}</dd>
              <dt className="text-cream/70">Minimum received</dt><dd className="break-all font-mono text-amber">{formatUnits(quote.min, quote.outDec)} {quote.outSym}</dd>
              <dt className="text-cream/70">Swap fee</dt><dd className="break-all font-mono">{formatUnits(quote.fee, quote.inDec)} {quote.inSym}</dd>
              <dt className="text-cream/70">Price impact</dt><dd className="font-mono">{fmtPct(Number(quote.impact))}</dd>
              <dt className="text-cream/70">Slippage</dt><dd className="font-mono">{quote.slippageBps / 100}%</dd>
              <dt className="text-cream/70">Quote age</dt><dd className={cn("font-mono", expired && "text-destructive")}>{expired ? "Expired — refresh" : `${Math.max(0, Math.ceil((QUOTE_TTL - (now - quote.at)) / 1000))}s left`}</dd>
            </dl>
          ) : <p className="mt-3 text-sm text-cream/70">Enter an amount and fetch a fresh quote. Changing the amount, direction, slippage, cluster, RPC or wallet discards the quote.</p>}
          {quote && quote.inRaw.lt(quote.requested) && <p className="mt-2 text-xs text-amber">Pool liquidity covers only part of this input within the fetched bins; only the "input used" amount is swapped.</p>}
          {!publicKey ? <div className="mt-4"><WalletButton /></div> : <Btn className="mt-4 w-full" onClick={doSwap} disabled={!quote || expired || busy || runner.running}>{runner.running ? "Working…" : "Swap with wallet"}</Btn>}
        </Panel>
        <TxSteps steps={runner.steps} />
      </div>
    </div>
  );
}

/* --------------------------------- Orders --------------------------------- */

const LO_STATUS = ["Not filled", "Partially filled", "Filled"];
const MAX_UI_ORDER_BINS = 10;

function Orders({ address, snap, symX, symY }: { address: string; snap: PoolSnapshot; symX: string; symY: string }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const sdk = usePoolSdk(address);
  const qc = useQueryClient();
  const runner = useTxRunner();
  const ctxKey = usePlanContext(address);
  const { settings } = useSettings();
  const support = useQuery({ queryKey: ["lo-support", ctxKey.rpc, ctxKey.cluster, address, sdk.dataUpdatedAt], enabled: !!sdk.data, queryFn: () => poolSupportsLimitOrders(sdk.data!) });
  const orders = useQuery({
    queryKey: ["limit-orders", ctxKey.rpc, ctxKey.cluster, address, publicKey?.toBase58()],
    enabled: !!sdk.data && !!publicKey && support.data?.ok === true,
    queryFn: ({ signal }) => discoverOrders(sdk.data!, connection, publicKey!, { cluster: ctxKey.cluster, customRpc: !!settings.rpc[settings.cluster] }, signal),
    structuralSharing: false,
    retry: 1,
  });

  const [side, setSide] = useState<"ask" | "bid">("ask");
  const [placement, setPlacement] = useState<"offset" | "price">("offset");
  const [offset, setOffset] = useState("1");
  const [priceStr, setPriceStr] = useState("");
  const [count, setCount] = useState("1");
  const [amt, setAmt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAsk = side === "ask";
  const inMint = isAsk ? snap.mintX : snap.mintY;
  const inDec = isAsk ? snap.decX : snap.decY;
  const inSym = isAsk ? symX : symY;
  const bal = useBalance(publicKey, inMint);

  // Ask (sell X) sits above the active bin; bid (buy X with Y) below it.
  const { startBin, placeErr } = useMemo(() => {
    if (placement === "offset") {
      const o = Number(offset);
      if (!Number.isInteger(o) || o < 1 || o > 500) return { startBin: NaN, placeErr: "Offset must be a whole number of bins from 1 to 500" };
      return { startBin: isAsk ? snap.activeId + o : snap.activeId - o, placeErr: null };
    }
    const b = binFromUiPrice(Number(priceStr), snap.binStep, snap.decX, snap.decY, isAsk ? "ceil" : "floor");
    if (!Number.isFinite(b)) return { startBin: NaN, placeErr: "Enter a positive price" };
    if (isAsk && b <= snap.activeId) return { startBin: NaN, placeErr: `A sell order must be priced above the active price (bin ${snap.activeId})` };
    if (!isAsk && b >= snap.activeId) return { startBin: NaN, placeErr: `A buy order must be priced below the active price (bin ${snap.activeId})` };
    return { startBin: b, placeErr: null };
  }, [placement, offset, priceStr, isAsk, snap.activeId, snap.binStep, snap.decX, snap.decY]);
  const n = Number(count);
  const countErr = !Number.isInteger(n) || n < 1 || n > MAX_UI_ORDER_BINS ? `Bins must be 1–${MAX_UI_ORDER_BINS}` : null;
  const binIds = !placeErr && !countErr ? Array.from({ length: n }, (_, i) => (isAsk ? startBin + i : startBin - i)).sort((a, b) => a - b) : [];
  const parsed = amt.trim() ? parseUnits(amt, inDec) : null;
  const amounts = parsed?.ok && binIds.length ? splitAmount(parsed.raw, binIds.length) : [];
  const amtErr = parsed && !parsed.ok ? parsed.error : parsed?.ok && amounts.some((a) => a.isZero()) ? "Amount too small to place in every bin" : parsed?.ok ? affordability(inMint, parsed.raw, bal.data, inSym) : null;

  type Review = { tx: Transaction; signer: Keypair; order: string; isAsk: boolean; bins: { id: number; amount: BN }[]; total: BN; cost: { limitOrderCost: number; binArrayCost: number; bitmapExtensionCost: number; binArraysCount: number }; sim: string | null; activeId: number; feeLamports: number | null };
  const liveKey = planKey({ ...ctxKey, side, bins: binIds.join(","), amt: parsed?.ok ? parsed.raw.toString() : amt });
  const { plan: review, begin, clear } = usePlan<Review>(liveKey);
  const canReview = !!publicKey && !!sdk.data && support.data?.ok && !placeErr && !countErr && parsed?.ok && !amtErr && !!bal.data && binIds.length > 0;

  async function prepare() {
    if (!canReview || !sdk.data || !publicKey || !parsed?.ok || busy) return;
    const job = begin();
    setBusy(true); setErr(null);
    try {
      const { Keypair } = await import("@solana/web3.js");
      await sdk.data.refetchStates();
      const bins = binIds.map((id, i) => ({ id, amount: amounts[i]! }));
      const cost = await sdk.data.quoteCreateLimitOrder({ bins: bins.map((b) => ({ id: b.id })) });
      const orderKp = Keypair.generate(); // ephemeral limit-order account signer, memory only
      const tx = await sdk.data.placeLimitOrder({ owner: publicKey, payer: publicKey, sender: publicKey, limitOrder: orderKp.publicKey, params: { isAskSide: isAsk, relativeBin: null, bins } });
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.feePayer = publicKey;
      const [sim, fee] = await Promise.all([
        simulateExact(connection, tx.serializeMessage()),
        connection.getFeeForMessage(tx.compileMessage(), "confirmed").then((r) => r.value).catch(() => null),
      ]);
      job.commit({ tx, signer: orderKp, order: orderKp.publicKey.toBase58(), isAsk, bins, total: parsed.raw, cost, sim: simText(sim), activeId: sdk.data.lbPair.activeId, feeLamports: fee });
    } catch (e) {
      if (job.isCurrent()) setErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally { setBusy(false); }
  }

  async function place() {
    if (!review || runner.running) return;
    const r = review;
    const res = await runner.run([{ label: `Place ${r.isAsk ? "sell" : "buy"} limit order (${r.bins.length} bin${r.bins.length > 1 ? "s" : ""})`, tx: r.tx, signers: [r.signer] }]);
    clear();
    if (res.length && res.every((x) => x.phase === "confirmed")) refresh();
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["limit-orders"] });
    qc.invalidateQueries({ queryKey: ["bal"] });
    qc.invalidateQueries({ queryKey: ["dlmm-snap"] });
  }

  async function act(kind: "cancel" | "close", orderPk: string, binIdsToCancel: number[]) {
    if (!sdk.data || !publicKey || runner.running) return;
    setErr(null);
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const pk = new PublicKey(orderPk);
      await sdk.data.refetchStates();
      const tx = kind === "cancel"
        ? await sdk.data.cancelLimitOrder({ limitOrderPubkey: pk, owner: publicKey, rentReceiver: publicKey, binIds: binIdsToCancel })
        : await sdk.data.closeLimitOrderIfEmpty({ limitOrder: pk, owner: publicKey, rentReceiver: publicKey });
      const res = await runner.run([{ label: kind === "cancel" ? `Cancel / withdraw ${binIdsToCancel.length} order bin(s)` : "Close empty limit order (reclaim rent)", tx }]);
      if (res.length && res.every((x) => x.phase === "confirmed")) refresh();
    } catch (e) { setErr(redactUrls(e instanceof Error ? e.message : String(e))); }
  }

  const mode = snap.functionType;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="display text-2xl">Native limit orders</h2><Cap kind={support.data?.ok ? "live" : "handoff"} /></div>
        <p className="mt-2 text-sm text-cream/80">Pool type: <strong className="text-amber">{fnName(mode)}</strong>. Native orders only work on pools set up to accept them; we check this on chain before showing the form.</p>
        {support.isPending && <Spinner label="Checking order support" />}
        {support.data && <p className={cn("mt-2 text-sm", support.data.ok ? "text-success" : "text-destructive")}>{support.data.reason}</p>}
        {support.data && !support.data.ok && <p className="mt-3 text-sm text-cream/75">One-sided liquidity (only {symX} above, or only {symY} below) is LP inventory, not a limit order — it is swapped back if price returns.</p>}
        {support.data?.ok && (
          <div className="mt-5 flex flex-col gap-4">
            <Segmented label="Order side" value={side} onChange={setSide} options={[{ value: "ask", label: `Sell ${symX}` }, { value: "bid", label: `Buy ${symX} with ${symY}` }]} />
            <Segmented label="Placement" value={placement} onChange={setPlacement} options={[{ value: "offset", label: "Bins from active" }, { value: "price", label: "Price" }]} />
            {placement === "offset"
              ? <Field label={`Bins ${isAsk ? "above" : "below"} active (${snap.activeId})`} inputMode="numeric" value={offset} onChange={(e) => setOffset(e.target.value)} />
              : <Field label={`Price (${symY} per ${symX})`} inputMode="decimal" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} hint={`Active ≈ ${fmtNum(snap.activePrice, 8)}. Rounded ${isAsk ? "up" : "down"} to a bin.`} />}
            <Field label="Spread across bins" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} hint={`1–${MAX_UI_ORDER_BINS} consecutive bins moving away from the price (program max 50).`} />
            <Field label={`Amount (${inSym})`} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} hint={publicKey ? <BalanceHint q={bal} mint={inMint} dec={inDec} sym={inSym} onMax={setAmt} /> : undefined} />
            {(placeErr || countErr || (amt && amtErr)) && <p role="alert" className="text-sm text-destructive">{placeErr ?? countErr ?? amtErr}</p>}
            {binIds.length > 0 && <p className="station-code break-words text-cream/75">Bins {binIds[0]} → {binIds[binIds.length - 1]} · {fmtNum(uiPriceFromBin(binIds[0]!, snap.binStep, snap.decX, snap.decY), 8)} – {fmtNum(uiPriceFromBin(binIds[binIds.length - 1]!, snap.binStep, snap.decX, snap.decY), 8)}</p>}
            {!publicKey ? <WalletButton /> : <Btn onClick={prepare} disabled={!canReview || busy}>{busy ? "Building…" : "Review order"}</Btn>}
            {err && <Notice tone="error" title="Order action failed">{err}</Notice>}
          </div>
        )}
      </Panel>
      <div className="flex flex-col gap-6">
        {review && (
          <Panel tone="cobalt">
            <h3 className="display text-2xl">Review order</h3>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/70">Side</dt><dd>{review.isAsk ? `Sell ${symX} for ${symY}` : `Buy ${symX} with ${symY}`}</dd>
              <dt className="text-cream/70">Deposit</dt><dd className="break-all font-mono">{formatUnits(review.total, review.isAsk ? snap.decX : snap.decY)} {review.isAsk ? symX : symY}</dd>
              <dt className="text-cream/70">Bins</dt><dd className="font-mono">{review.bins.map((b) => b.id).join(", ")}</dd>
              <dt className="text-cream/70">Active at build</dt><dd className="font-mono">{review.activeId}</dd>
              <dt className="text-cream/70">Order account rent</dt><dd className="font-mono">{fmtNum(review.cost.limitOrderCost, 6)} SOL</dd>
              <dt className="text-cream/70">New bin arrays</dt><dd className="font-mono">{review.cost.binArraysCount} · {fmtNum(review.cost.binArrayCost, 6)} SOL</dd>
              <dt className="text-cream/70">Bitmap extension</dt><dd className="font-mono">{fmtNum(review.cost.bitmapExtensionCost, 6)} SOL</dd>
              <dt className="text-cream/70">Network fee</dt><dd className="font-mono">{review.feeLamports !== null ? `${formatUnits(String(review.feeLamports), 9)} SOL` : DASH}</dd>
              <dt className="text-cream/70">Order account</dt><dd className="font-mono">{shortAddr(review.order, 6)}</dd>
            </dl>
            <p className="mt-3 text-xs text-cream/70">Fills happen when swaps cross these bins. If the active price has already moved past a bin when the transaction lands, the program decides the outcome — simulation runs against the current state.</p>
            {review.sim ? <Notice tone="error" title="Simulation failed — not sent">{review.sim}</Notice> : <p className="mt-3 station-code text-success">Exact message simulation passed</p>}
            <Btn className="mt-4 w-full" onClick={place} disabled={!!review.sim || runner.running}>{runner.running ? "Working…" : "Sign & place order"}</Btn>
          </Panel>
        )}
        <TxSteps steps={runner.steps} />
        <Panel>
          <div className="flex items-center justify-between"><h3 className="station-code text-amber">Your orders in this pool</h3>{orders.data && <Btn size="sm" variant="line" onClick={() => orders.refetch()}>Refresh</Btn>}</div>
          {!publicKey && <p className="mt-3 text-sm text-cream/70">Connect a wallet to read your orders.</p>}
          {publicKey && support.data?.ok && orders.isPending && <Spinner label="Reading your orders" />}
          {orders.isError && <Notice tone="error" title="Couldn't read orders" action={<Btn size="sm" onClick={() => orders.refetch()}>Retry</Btn>}>{redactUrls(String(((orders.error) as Error)?.message ?? ""))}. {ctxKey.cluster === "mainnet-beta" && !settings.rpc[settings.cluster] ? "Orders are found via Meteora's index, then checked on chain." : "This network scans the chain, which some RPCs restrict; a dedicated RPC may be required."}</Notice>}
          {orders.data && (orders.data.report.rejected > 0 || orders.data.report.truncated) && <Notice tone="warn" title="Order list may be incomplete">{orders.data.report.rejected > 0 && `${orders.data.report.rejected} indexed order(s) failed on-chain verification and are hidden. `}{orders.data.report.truncated && `The index reports ${orders.data.report.indexedTotal ?? "more"} orders; only the first 250 are read.`}</Notice>}
          {orders.data && orders.data.length === 0 && <p className="mt-3 text-sm text-cream/70">No limit orders for this wallet in this pool.</p>}
          {orders.data?.map((o) => {
            const d = o.limitOrderData;
            const open = d.limitOrderBinData.filter((b) => !b.empty);
            return (
              <div key={o.publicKey.toBase58()} className="mt-4 border border-line p-3 text-sm">
                <p className="font-mono text-xs">{shortAddr(o.publicKey.toBase58(), 6)}</p>
                <dl className="mt-2 grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-cream/65">Deposited</dt><dd className="break-all font-mono">{formatUnits(d.totalDepositAmountX, snap.decX)} {symX} · {formatUnits(d.totalDepositAmountY, snap.decY)} {symY}</dd>
                  <dt className="text-cream/65">Unfilled</dt><dd className="break-all font-mono">{formatUnits(d.totalUnfilledAmountX, snap.decX)} {symX} · {formatUnits(d.totalUnfilledAmountY, snap.decY)} {symY}</dd>
                  <dt className="text-cream/65">Filled</dt><dd className="break-all font-mono">{formatUnits(d.totalFilledAmountX, snap.decX)} {symX} · {formatUnits(d.totalFilledAmountY, snap.decY)} {symY}</dd>
                  <dt className="text-cream/65">Withdrawable</dt><dd className="break-all font-mono">{formatUnits(d.transferFeeExcludedWithdrawableAmountX, snap.decX)} {symX} · {formatUnits(d.transferFeeExcludedWithdrawableAmountY, snap.decY)} {symY}</dd>
                </dl>
                {open.length > 0 && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[360px] text-xs">
                      <thead><tr className="text-left text-cream/60"><th className="py-1">Bin</th><th>Side</th><th>Status</th><th>Unfilled</th></tr></thead>
                      <tbody>{open.map((b) => (
                        <tr key={b.binId} className="border-t border-line/50"><td className="py-1 font-mono">{b.binId}</td><td>{b.isAskSide ? "Sell" : "Buy"}</td><td>{LO_STATUS[b.status] ?? DASH}</td><td className="font-mono">{b.isAskSide ? `${formatUnits(b.unfilledAmountX, snap.decX)} ${symX}` : `${formatUnits(b.unfilledAmountY, snap.decY)} ${symY}`}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {open.length > 0 && <Btn size="sm" variant="line" disabled={runner.running} onClick={() => act("cancel", o.publicKey.toBase58(), open.map((b) => b.binId))}>Cancel & withdraw all bins</Btn>}
                  {open.length === 0 && <Btn size="sm" variant="line" disabled={runner.running} onClick={() => act("close", o.publicKey.toBase58(), [])}>Close & reclaim rent</Btn>}
                </div>
              </div>
            );
          })}
          <p className="mt-4 text-xs text-cream/60">The SDK has no separate "claim filled" call: cancelLimitOrder withdraws whatever the selected bins hold (unfilled input and filled output) to your wallet; closeLimitOrderIfEmpty then reclaims the account rent. Review amounts in the simulation before signing.</p>
        </Panel>
      </div>
    </div>
  );
}

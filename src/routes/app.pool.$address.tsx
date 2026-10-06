import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import BN from "bn.js";
import type { Keypair } from "@solana/web3.js";
import { Btn, Cap, Field, Notice, Panel, Segmented, Spinner, Stat, Eyebrow } from "@/components/kit";
import { RailMap } from "@/components/app/RailMap";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { useBalance, usePoolSdk, usePoolSnapshot, type PoolSnapshot } from "@/components/app/pool-hooks";
import { WalletButton } from "@/components/wallet/WalletButton";
import { fetchPool, v24 } from "@/lib/meteora-api";
import { formatUnits, parseUnits } from "@/lib/amount";
import { uiPriceFromBin, binFromUiPrice, pctMoveBetweenBins } from "@/lib/bins";
import { DASH, explorerAccount, fmtNum, fmtPct, fmtUsd, isBase58Address, shortAddr, timeAgo } from "@/lib/format";
import { MAX_UI_BINS, STRATEGIES, STRATEGY_TYPE_VALUE, distribute, type StrategyName } from "@/lib/strategy";
import { useSettings, useStars } from "@/lib/settings";
import { loadSdk } from "@/lib/dlmm";
import { cn } from "@/lib/utils";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

const search = z.object({
  tab: z.enum(["overview", "add", "swap", "orders"]).optional().catch(undefined),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]).optional().catch(undefined),
  below: z.number().int().min(0).max(MAX_UI_BINS).optional().catch(undefined),
  above: z.number().int().min(0).max(MAX_UI_BINS).optional().catch(undefined),
  x: z.string().max(40).optional().catch(undefined),
  y: z.string().max(40).optional().catch(undefined),
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
          {((sdk.error ?? snap.error) as Error)?.message}. Check the cluster and RPC endpoint in Settings. The public RPC is rate-limited.
        </Notice>
      )}

      {tab === "overview" && <Overview address={address} api={api} snap={snap.data} snapLoading={snap.isPending && !sdk.isError} symX={symX} symY={symY} updatedAt={snap.dataUpdatedAt} />}
      {tab === "add" && (snap.data ? <AddLiquidity address={address} snap={snap.data} symX={symX} symY={symY} prefill={s} /> : !sdk.isError && <Spinner label="Loading pool bins" />)}
      {tab === "swap" && (snap.data ? <Swap address={address} snap={snap.data} symX={symX} symY={symY} /> : !sdk.isError && <Spinner label="Loading pool" />)}
      {tab === "orders" && (snap.data ? <Orders address={address} snap={snap.data} /> : !sdk.isError && <Spinner label="Reading pool mode" />)}
    </div>
  );
}

function Overview({ address, api, snap, snapLoading, symX, symY, updatedAt }: { address: string; api: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchPool>>>>; snap?: PoolSnapshot; snapLoading: boolean; symX: string; symY: string; updatedAt: number }) {
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
      <div className="flex flex-col gap-6">
        <Panel tone="cobalt">
          <h2 className="station-code text-amber">Market · Meteora API</h2>
          {api.isError && <p className="mt-2 text-sm text-destructive">API data unavailable: {(api.error as Error).message}</p>}
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
            <dt className="text-cream/65">Token X</dt><dd className="font-mono">{snap ? <a className="underline" href={explorerAccount(snap.mintX, "mainnet-beta")} target="_blank" rel="noreferrer">{symX} · {snap.decX}d</a> : DASH}</dd>
            <dt className="text-cream/65">Token Y</dt><dd className="font-mono">{snap ? <a className="underline" href={explorerAccount(snap.mintY, "mainnet-beta")} target="_blank" rel="noreferrer">{symY} · {snap.decY}d</a> : DASH}</dd>
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

/* ------------------------------ Add liquidity ------------------------------ */

function AddLiquidity({ address, snap, symX, symY, prefill }: { address: string; snap: PoolSnapshot; symX: string; symY: string; prefill: z.infer<typeof search> }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const { settings } = useSettings();
  const sdk = usePoolSdk(address);
  const qc = useQueryClient();
  const [strategy, setStrategy] = useState<StrategyName>(prefill.strategy ?? "Spot");
  const [mode, setMode] = useState<"bins" | "price">("bins");
  const [below, setBelow] = useState(String(prefill.below ?? 10));
  const [above, setAbove] = useState(String(prefill.above ?? 10));
  const [minP, setMinP] = useState("");
  const [maxP, setMaxP] = useState("");
  const [xAmt, setXAmt] = useState(prefill.x ?? "");
  const [yAmt, setYAmt] = useState(prefill.y ?? "");
  const [review, setReview] = useState<null | { tx: import("@solana/web3.js").Transaction; feeLamports: number | null; rentLamports: number; position: string; sim: string | null }>(null);
  const [prepErr, setPrepErr] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const kp = useRef<Keypair | null>(null);
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
  }, [mode, below, above, minP, maxP, snap]);

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
  else if (balX.data && xRaw!.gt(balX.data)) amtErr = `${symX} amount exceeds your balance`;
  else if (balY.data && yRaw!.gt(balY.data)) amtErr = `${symY} amount exceeds your balance`;

  const preview = !rangeErr && !widthErr ? distribute(strategy, snap.activeId, minBin, maxBin) : [];
  const canReview = !!publicKey && !rangeErr && !widthErr && !amtErr && !!sdk.data && !balX.isError && !balY.isError;

  useEffect(() => { setReview(null); kp.current = null; }, [strategy, minBin, maxBin, xAmt, yAmt]);

  async function prepare() {
    if (!sdk.data || !publicKey || !xRaw || !yRaw) return;
    setPreparing(true);
    setPrepErr(null);
    try {
      const { Keypair } = await import("@solana/web3.js");
      await loadSdk();
      const positionKp = Keypair.generate(); // ephemeral: memory only, never persisted or logged
      kp.current = positionKp;
      await sdk.data.refetchStates();
      const tx = await sdk.data.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        totalXAmount: xRaw,
        totalYAmount: yRaw,
        strategy: { minBinId: minBin, maxBinId: maxBin, strategyType: STRATEGY_TYPE_VALUE[strategy] },
        user: publicKey,
        slippage: settings.slippageBps / 100,
      });
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const { POSITION_MIN_SIZE } = await loadSdk();
      const [fee, rent, sim] = await Promise.all([
        connection.getFeeForMessage(tx.compileMessage(), "confirmed").then((r) => r.value).catch(() => null),
        connection.getMinimumBalanceForRentExemption(POSITION_MIN_SIZE),
        connection.simulateTransaction(tx),
      ]);
      setReview({ tx, feeLamports: fee, rentLamports: rent, position: positionKp.publicKey.toBase58(), sim: sim.value.err ? `${JSON.stringify(sim.value.err)} — ${(sim.value.logs ?? []).slice(-3).join(" | ")}` : null });
    } catch (e) {
      kp.current = null;
      setPrepErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  }

  async function execute() {
    if (!review || !kp.current) return;
    const signer = kp.current;
    const res = await runner.run([{ label: "Create position and add liquidity", tx: review.tx, signers: [signer] }]);
    kp.current = null; // drop ephemeral key
    if (res.every((r) => r.phase === "confirmed")) {
      setReview(null);
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
            <p className="station-code text-cream/75">
              Bins {minBin} → {maxBin} · {width} bins · {fmtNum(lowPrice, 6)} – {fmtNum(highPrice, 6)} ({fmtPct(pctMoveBetweenBins(snap.activeId, minBin, snap.binStep))} / +{fmtPct(pctMoveBetweenBins(snap.activeId, maxBin, snap.binStep))})
            </p>
          )}
          <Field label={`${symX} amount`} inputMode="decimal" value={xAmt} onChange={(e) => setXAmt(e.target.value)} hint={publicKey ? <BalanceHint q={balX} dec={snap.decX} sym={symX} onMax={(v) => setXAmt(v)} /> : undefined} disabled={onlyBelow} />
          <Field label={`${symY} amount`} inputMode="decimal" value={yAmt} onChange={(e) => setYAmt(e.target.value)} hint={publicKey ? <BalanceHint q={balY} dec={snap.decY} sym={symY} onMax={(v) => setYAmt(v)} /> : undefined} disabled={onlyAbove} />
          {amtErr && (xAmt || yAmt) && <p role="alert" className="text-sm text-destructive">{amtErr}</p>}
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
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/70">Pool</dt><dd className="font-mono">{shortAddr(address, 6)}</dd>
              <dt className="text-cream/70">Strategy</dt><dd>{strategy}</dd>
              <dt className="text-cream/70">Bins</dt><dd className="font-mono">{minBin} → {maxBin} ({width})</dd>
              <dt className="text-cream/70">Deposit {symX}</dt><dd className="font-mono">{formatUnits(xRaw!, snap.decX)}</dd>
              <dt className="text-cream/70">Deposit {symY}</dt><dd className="font-mono">{formatUnits(yRaw!, snap.decY)}</dd>
              <dt className="text-cream/70">Slippage</dt><dd className="font-mono">{settings.slippageBps / 100}%</dd>
              <dt className="text-cream/70">Network fee</dt><dd className="font-mono">{review.feeLamports !== null ? `${formatUnits(String(review.feeLamports), 9)} SOL` : DASH}</dd>
              <dt className="text-cream/70">Position rent</dt><dd className="font-mono">~{formatUnits(String(review.rentLamports), 9, 5)} SOL (refundable on close)</dd>
              <dt className="text-cream/70">New position</dt><dd className="font-mono">{shortAddr(review.position, 6)}</dd>
            </dl>
            <p className="mt-3 text-xs text-cream/70">Additional rent may apply if new bin arrays must be initialised; it appears in your wallet's preview.</p>
            {review.sim ? <Notice tone="error" title="Simulation failed — not sent">{review.sim}</Notice> : <p className="mt-3 station-code text-success">Simulation passed</p>}
            <Btn className="mt-4 w-full" onClick={execute} disabled={!!review.sim || runner.running}>{runner.running ? "Working…" : "Sign & send with wallet"}</Btn>
          </Panel>
        )}
        <TxSteps steps={runner.steps} />
      </div>
    </div>
  );
}

function BalanceHint({ q, dec, sym, onMax }: { q: ReturnType<typeof useBalance>; dec: number; sym: string; onMax: (v: string) => void }) {
  if (q.isPending) return <>Reading balance…</>;
  if (q.isError) return <span className="text-destructive">Balance unavailable ({(q.error as Error).message.slice(0, 60)})</span>;
  const v = formatUnits(q.data!, dec).replace(/,/g, "");
  return (
    <>Balance {formatUnits(q.data!, dec, 6)} {sym} · <button type="button" className="underline" onClick={() => onMax(v)}>Max</button></>
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
  const [xToY, setXToY] = useState(true);
  const [amt, setAmt] = useState("");
  const [quote, setQuote] = useState<null | { at: number; inRaw: BN; out: BN; min: BN; fee: BN; impact: string; binArrays: import("@solana/web3.js").PublicKey[] }>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => setQuote(null), [amt, xToY]);

  const inDec = xToY ? snap.decX : snap.decY;
  const outDec = xToY ? snap.decY : snap.decX;
  const inSym = xToY ? symX : symY;
  const outSym = xToY ? symY : symX;
  const bal = useBalance(publicKey, xToY ? snap.mintX : snap.mintY);
  const parsed = amt.trim() ? parseUnits(amt, inDec) : null;
  const inputErr = parsed && !parsed.ok ? parsed.error : parsed?.ok && parsed.raw.isZero() ? "Amount must be greater than 0" : parsed?.ok && bal.data && parsed.raw.gt(bal.data) ? "Exceeds your balance" : null;
  const expired = quote ? now - quote.at > QUOTE_TTL : false;

  async function getQuote() {
    if (!sdk.data || !parsed?.ok) return;
    setBusy(true);
    setQErr(null);
    try {
      await sdk.data.refetchStates();
      const arrays = await sdk.data.getBinArrayForSwap(xToY, 4);
      const q = sdk.data.swapQuote(parsed.raw, xToY, new BN(settings.slippageBps), arrays);
      setQuote({ at: Date.now(), inRaw: q.consumedInAmount, out: q.outAmount, min: q.minOutAmount, fee: q.fee, impact: q.priceImpact.toString(), binArrays: q.binArraysPubkey });
    } catch (e) {
      setQErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doSwap() {
    if (!sdk.data || !publicKey || !quote || expired) return;
    setBusy(true);
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const tx = await sdk.data.swap({
        inToken: new PublicKey(xToY ? snap.mintX : snap.mintY),
        outToken: new PublicKey(xToY ? snap.mintY : snap.mintX),
        inAmount: quote.inRaw,
        minOutAmount: quote.min,
        lbPair: sdk.data.pubkey,
        user: publicKey,
        binArraysPubkey: quote.binArrays,
      });
      const res = await runner.run([{ label: `Swap ${inSym} → ${outSym}`, tx }]);
      if (res.every((r) => r.phase === "confirmed")) {
        setQuote(null);
        setAmt("");
        qc.invalidateQueries({ queryKey: ["bal"] });
        qc.invalidateQueries({ queryKey: ["dlmm-snap"] });
      }
    } catch (e) {
      setQErr(e instanceof Error ? e.message : String(e));
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
          <Field label={`You pay (${inSym})`} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} error={amt ? inputErr : null} hint={publicKey ? <BalanceHint q={bal} dec={inDec} sym={inSym} onMax={setAmt} /> : undefined} />
          <Btn variant="line" size="sm" onClick={() => setXToY((v) => !v)} aria-label="Reverse swap direction">⇅ Reverse: {inSym} → {outSym}</Btn>
          <Btn variant="quiet" onClick={getQuote} disabled={!parsed?.ok || !!inputErr || busy || !sdk.data}>{busy && !quote ? "Quoting…" : quote ? "Refresh quote" : "Get quote"}</Btn>
          {qErr && <Notice tone="error" title="Quote or swap failed">{qErr}</Notice>}
        </div>
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel tone="cobalt">
          <h3 className="station-code text-amber">Quote · SDK</h3>
          {quote ? (
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/70">Input used</dt><dd className="font-mono">{formatUnits(quote.inRaw, inDec)} {inSym}</dd>
              <dt className="text-cream/70">Expected out</dt><dd className="font-mono">{formatUnits(quote.out, outDec)} {outSym}</dd>
              <dt className="text-cream/70">Minimum received</dt><dd className="font-mono text-amber">{formatUnits(quote.min, outDec)} {outSym}</dd>
              <dt className="text-cream/70">Swap fee</dt><dd className="font-mono">{formatUnits(quote.fee, inDec)} {inSym}</dd>
              <dt className="text-cream/70">Price impact</dt><dd className="font-mono">{fmtPct(Number(quote.impact))}</dd>
              <dt className="text-cream/70">Slippage</dt><dd className="font-mono">{settings.slippageBps / 100}%</dd>
              <dt className="text-cream/70">Quote age</dt><dd className={cn("font-mono", expired && "text-destructive")}>{expired ? "Expired — refresh" : `${Math.max(0, Math.ceil((QUOTE_TTL - (now - quote.at)) / 1000))}s left`}</dd>
            </dl>
          ) : <p className="mt-3 text-sm text-cream/70">Enter an amount and fetch a fresh quote.</p>}
          {quote && quote.inRaw.lt(parsed?.ok ? parsed.raw : new BN(0)) && <p className="mt-2 text-xs text-amber">Pool liquidity covers only part of this input within the fetched bins.</p>}
          {!publicKey ? <div className="mt-4"><WalletButton /></div> : <Btn className="mt-4 w-full" onClick={doSwap} disabled={!quote || expired || busy || runner.running}>{runner.running ? "Working…" : "Swap with wallet"}</Btn>}
        </Panel>
        <TxSteps steps={runner.steps} />
      </div>
    </div>
  );
}

/* --------------------------------- Orders --------------------------------- */

function Orders({ address, snap }: { address: string; snap: PoolSnapshot }) {
  return (
    <Panel>
      <h2 className="display text-2xl">Orders</h2>
      <p className="mt-2 text-cream/80">Onchain function mode: <strong className="text-amber">{fnName(snap.functionType)}</strong></p>
      {snap.functionType === 2 ? (
        <div className="mt-4 flex flex-col gap-3 text-sm text-cream/80">
          <p>This pool is in Limit Order mode, so the DLMM program supports native limit orders here.</p>
          <Notice tone="warn" title="Order placement isn't implemented in Studio Loco yet">
            We read the mode from chain but haven't shipped and tested the native order adapter. You can place orders in Meteora's app.
          </Notice>
          <a className="underline" href={`https://app.meteora.ag/dlmm/${address}`} target="_blank" rel="noreferrer">Open this pool on Meteora ↗</a>
        </div>
      ) : (
        <div className="mt-4 text-sm text-cream/80">
          <p>Native limit orders are not available for this pool's mode. One-sided liquidity (only {""}X above or only Y below) is LP inventory, not a limit order — it can be swapped back if price returns.</p>
        </div>
      )}
      <div className="mt-4"><Cap kind="handoff" /></div>
    </Panel>
  );
}

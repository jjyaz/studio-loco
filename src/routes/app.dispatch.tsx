import { createFileRoute } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState } from "react";
import BN from "bn.js";
import { Btn, Field, Notice, PageHead, Panel, Stat } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { formatUnits } from "@/lib/amount";
import { explorerAccount, explorerTx, fmtPct, redactUrls, shortAddr } from "@/lib/format";
import { useLocalState, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CONFIG, QUOTE_TTL_MS, USDC_MINT, WSOL_MINT, checkConfig, evaluateRoute, parseConfig, realizedDeltas,
  type ArbConfig, type Costs, type TxMetaLike,
} from "@/lib/arb-math";
import type { BuiltArb, QuotedLeg, RouteResult, ScanResult, WalletAccounts } from "@/lib/arb";

export const Route = createFileRoute("/app/dispatch")({
  head: () => ({
    meta: [
      { title: "Dispatch · SOL/USDC DLMM round-trip agent — Studio Loco" },
      { name: "description", content: "Scan real Meteora DLMM SOL/USDC pools for two-pool round trips using executable SDK quotes, then review and sign one atomic transaction." },
      { property: "og:title", content: "Dispatch — Studio Loco arbitrage agent" },
      { property: "og:description", content: "Read-only route discovery with real swapQuote results; one atomic, simulated, wallet-approved transaction per route." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dispatch,
});

const SOL = (v: BN | null | undefined) => (v ? `${formatUnits(v, 9)} SOL` : "—");
const USDC = (v: BN | null | undefined) => (v ? `${formatUnits(v, 6)} USDC` : "—");
type Log = { at: number; tone: "info" | "warn" | "error" | "ok"; text: string };

interface Review {
  at: number; key: string; route: RouteResult; a: QuotedLeg; b: QuotedLeg; w: WalletAccounts;
  costs: Costs; floor: BN; conservativeProfit: BN; expectedProfit: BN; residualUsdc: BN; built: BuiltArb;
}

function Dispatch() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const [cfg, setCfg] = useLocalState<ArbConfig>("studio-loco:dispatch:v1", DEFAULT_CONFIG, (r) => { try { return parseConfig(r); } catch { return DEFAULT_CONFIG; } });
  const chk = checkConfig(cfg);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [log, setLog] = useState<Log[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [revErr, setRevErr] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [realized, setRealized] = useState<null | { sig: string; text: string[] }>(null);
  const [now, setNow] = useState(() => Date.now());
  const [importText, setImportText] = useState("");
  const runner = useTxRunner();
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const failures = useRef(0);

  const mainnet = settings.cluster === "mainnet-beta";
  const blocked = !mainnet ? "Dispatch supports mainnet SOL/USDC only. Switch the cluster in Settings." : settings.practice ? "Practice mode is on — Dispatch never uses practice data. Turn it off to scan real pools." : null;
  const envKey = `${publicKey?.toBase58() ?? "-"}|${settings.cluster}|${settings.rpc[settings.cluster] ?? ""}|${settings.practice}|${JSON.stringify(cfg)}`;
  const push = (tone: Log["tone"], text: string) => setLog((l) => [{ at: Date.now(), tone, text: redactUrls(text) }, ...l].slice(0, 200));

  // any identity/settings change invalidates review and stops monitoring
  const prevKey = useRef(envKey);
  useEffect(() => {
    if (prevKey.current === envKey) return;
    prevKey.current = envKey;
    abort.current?.abort();
    setReview(null);
    setMonitor((m) => { if (m) push("warn", "Monitoring paused: wallet, network, RPC, practice or configuration changed."); return false; });
  }, [envKey]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const vis = () => { if (document.hidden) setMonitor((m) => { if (m) push("warn", "Monitoring paused: tab hidden."); return false; }); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);

  async function scanOnce(source: "manual" | "monitor") {
    if (busy.current || blocked || !chk.ok) return;
    busy.current = true; setScanning(true); setScanErr(null);
    const ac = new AbortController(); abort.current = ac;
    try {
      const { scanRoutes } = await import("@/lib/arb");
      const rent = await connection.getMinimumBalanceForRentExemption(165, "confirmed");
      const { priorityFeeLamports, priorityPrice, BASE_FEE_PER_SIGNATURE } = await import("@/lib/arb-math");
      // Read-only worst case: assumes a new USDC account must be created and kept.
      const costs: Costs = { baseFee: new BN(BASE_FEE_PER_SIGNATURE), priorityFee: priorityFeeLamports(priorityPrice(chk.priorityBudget, cfg.computeUnits), cfg.computeUnits), nonRefundableRent: new BN(rent), refundableRent: new BN(rent) };
      const r = await scanRoutes(connection, { inLamports: chk.inLamports, minProfit: chk.minProfit, slippageBps: cfg.slippageBps, maxPools: cfg.maxPools, costs, signal: ac.signal, log: (m) => push("info", m) });
      if (ac.signal.aborted) return;
      setScan(r); failures.current = 0;
      const prof = r.routes.filter((x) => x.verdict.kind === "profitable").length;
      const errs = r.pools.filter((p) => p.status !== "ok" || p.reason).length;
      push(prof ? "ok" : "info", `${source === "monitor" ? "Monitor" : "Scan"}: ${r.routes.length} routes quoted, ${prof} meet the net-profit floor${errs ? `, ${errs} pool(s) rejected or errored` : ""}.`);
    } catch (e) {
      if (ac.signal.aborted) { push("warn", "Scan cancelled."); return; }
      failures.current++;
      const m = redactUrls(e instanceof Error ? e.message : String(e));
      setScanErr(m); push("error", `Scan failed: ${m}`);
    } finally { busy.current = false; setScanning(false); }
  }

  // monitoring loop: sequential, no overlap, exponential backoff on failure, proposals only
  useEffect(() => {
    if (!monitor) return;
    let stop = false; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      await scanOnce("monitor");
      if (stop) return;
      const back = Math.min(300, cfg.intervalSec * 2 ** Math.min(failures.current, 4));
      t = setTimeout(tick, back * 1000);
    };
    push("info", `Monitoring started (every ${cfg.intervalSec}s, this tab only, discovers proposals — never signs).`);
    void tick();
    return () => { stop = true; clearTimeout(t); abort.current?.abort(); };
  }, [monitor]); // eslint-disable-line react-hooks/exhaustive-deps

  async function requote(route: RouteResult) {
    if (!publicKey || !chk.ok || blocked || reviewing) return;
    setReviewing(true); setRevErr(null); setReview(null);
    const key = envKey + "|" + route.a.pool + ">" + (route.b?.pool ?? "");
    try {
      const arb = await import("@/lib/arb");
      const { getPool, invalidatePool } = await import("@/lib/dlmm");
      const [poolA, poolB] = await Promise.all([route.a.pool, route.b!.pool].map(async (p) => { invalidatePool(p); const x = await getPool(connection, p, "mainnet-beta"); await x.refetchStates(); return x; }));
      for (const p of [poolA!, poolB!]) { const bad = await arb.verifyPool(connection, p); if (bad) throw new Error(`${shortAddr(p.pubkey.toBase58())}: ${bad}`); }
      const mintErr = await arb.verifyMints(connection); if (mintErr) throw new Error(mintErr);
      const w = await arb.readWalletAccounts(connection, publicKey);
      const costs = arb.walletCosts(w, chk.priorityBudget, cfg.computeUnits);
      const a = await arb.quoteLeg(poolA!, WSOL_MINT, chk.inLamports, cfg.slippageBps);
      if (!a.consumed.eq(a.requested)) throw new Error("Leg A would be a partial fill — rejected");
      const b = await arb.quoteLeg(poolB!, USDC_MINT, a.min, cfg.slippageBps);
      const v = evaluateRoute(a, b, chk.minProfit, costs);
      if (v.kind !== "profitable") throw new Error(v.kind === "invalid" ? v.reason : `No profitable route right now: ${v.reason}. Expected net ${v.expectedProfit ? SOL(v.expectedProfit) : "—"}.`);
      // Balance: input + fees + every rent deposit (refundable WSOL rent is still needed up front)
      const need = chk.inLamports.add(v.costs).add(costs.refundableRent ?? new BN(0));
      if (w.lamports.lt(need)) throw new Error(`Insufficient SOL: need ${SOL(need)}, wallet has ${SOL(w.lamports)}`);
      const built = await arb.buildArbTx({ user: publicKey, poolA: poolA!, poolB: poolB!, a, b, floor: v.floor, w, microLamports: costs.microLamports, computeUnits: cfg.computeUnits });
      setReview({ at: Date.now(), key, route, a, b, w, costs, floor: v.floor, conservativeProfit: v.conservativeProfit, expectedProfit: v.expectedProfit, residualUsdc: v.residualUsdc, built });
      push("info", `Review ready: ${route.nameA} → ${route.nameB}, ${built.bytes} bytes, quote valid ${QUOTE_TTL_MS / 1000}s.`);
    } catch (e) {
      const m = redactUrls(e instanceof Error ? e.message : String(e));
      setRevErr(m); push("warn", `Requote: ${m}`);
    } finally { setReviewing(false); }
  }

  const expired = review ? now - review.at > QUOTE_TTL_MS : false;
  const stale = review ? !review.key.startsWith(envKey + "|") : false;

  async function approve() {
    if (!review || expired || stale || runner.running || !publicKey) return;
    const r = review;
    setReview(null); // single use: never re-sent
    push("info", "Sending to wallet for approval (one atomic transaction)…");
    try {
      const steps = await runner.run([{ label: `Round trip ${r.route.nameA} → ${r.route.nameB}`, tx: r.built.tx }]);
      const s = steps[0];
      push(s?.phase === "confirmed" ? "ok" : "warn", `Transaction ${s?.phase ?? "not run"}${s?.signature ? ` · ${shortAddr(s.signature, 6)}` : ""}${s?.error ? `: ${s.error}` : ""}`);
      if (s?.phase === "confirmed" && s.signature) {
        try {
          const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) { setRealized({ sig: s.signature, text: ["Confirmed, but transaction metadata is not available from this RPC yet — realized deltas unknown."] }); return; }
          const d = realizedDeltas(tx.meta as unknown as TxMetaLike, publicKey.toBase58());
          setRealized({ sig: s.signature, text: [
            `Network fee charged: ${SOL(d.fee)}`, `Native SOL change (incl. fee, rent): ${SOL(d.lamports)}`,
            `WSOL token change: ${SOL(d.wsol)}`, `USDC change (residual dust): ${USDC(d.usdc)}`,
            `Realized net SOL (native + WSOL): ${SOL(d.netSol)}`,
          ] });
        } catch (e) { setRealized({ sig: s.signature, text: [`Confirmed; metadata read failed: ${redactUrls(e instanceof Error ? e.message : String(e))}`] }); }
      }
    } catch (e) { push("error", redactUrls(e instanceof Error ? e.message : String(e))); }
  }

  function exportCfg() {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "studio-loco-dispatch.json"; a.click(); URL.revokeObjectURL(a.href);
  }
  function importCfg() {
    try { setCfg(parseConfig(JSON.parse(importText))); setImportText(""); push("ok", "Configuration imported."); }
    catch (e) { push("error", `Import rejected: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const set = (k: keyof ArbConfig, v: string) => setCfg({ ...cfg, [k]: typeof DEFAULT_CONFIG[k] === "number" ? Math.round(Number(v)) : v });

  const routes = scan?.routes ?? [];
  const best = useMemo(() => routes.find((r) => r.verdict.kind === "profitable") ?? null, [routes]);

  return (
    <div>
      <PageHead code="ST-06 · Dispatch" title="Two pools, one train." intro="Finds SOL → USDC → SOL round trips across two Meteora DLMM pools using real SDK quotes. Scanning is read-only. A route executes only as one atomic transaction that you review, simulate and approve." cap={["live"]} />
      {blocked && <div className="mb-6"><Notice tone="warn" title="Dispatch unavailable">{blocked}</Notice></div>}
      <div className="mb-6"><Notice tone="info" title="Read before using">Estimates are not guarantees. A transaction that fails onchain still pays its network and priority fees. Monitoring runs only in this open tab, finds proposals and never signs. Ordinary DLMM program only — DLMM Pro is not integrated.</Notice></div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div className="flex flex-col gap-6">
          <Panel>
            <h2 className="display text-2xl">Route config</h2>
            <dl className="mt-3 text-xs">
              <dt className="station-code text-cream/65">WSOL mint</dt><dd className="break-all font-mono"><a className="underline" href={explorerAccount(WSOL_MINT, "mainnet-beta")} target="_blank" rel="noreferrer">{WSOL_MINT}</a></dd>
              <dt className="station-code mt-2 text-cream/65">USDC mint</dt><dd className="break-all font-mono"><a className="underline" href={explorerAccount(USDC_MINT, "mainnet-beta")} target="_blank" rel="noreferrer">{USDC_MINT}</a></dd>
            </dl>
            <div className="mt-4 flex flex-col gap-3">
              <Field label="Input" suffix="SOL" inputMode="decimal" value={cfg.inputSol} onChange={(e) => set("inputSol", e.target.value)} />
              <Field label="Minimum net profit" suffix="SOL" inputMode="decimal" value={cfg.minProfitSol} onChange={(e) => set("minProfitSol", e.target.value)} />
              <Field label="Slippage per leg" suffix="bps" inputMode="numeric" value={String(cfg.slippageBps)} onChange={(e) => set("slippageBps", e.target.value)} hint="1–300 bps. Applied to each leg's minimum output." />
              <Field label="Priority-fee budget" suffix="SOL" inputMode="decimal" value={cfg.priorityFeeSol} onChange={(e) => set("priorityFeeSol", e.target.value)} />
              <Field label="Compute-unit limit" inputMode="numeric" value={String(cfg.computeUnits)} onChange={(e) => set("computeUnits", e.target.value)} />
              <Field label="Monitor interval" suffix="s" inputMode="numeric" value={String(cfg.intervalSec)} onChange={(e) => set("intervalSec", e.target.value)} hint="10–600 s; backs off after errors." />
              <Field label="Pools to compare" inputMode="numeric" value={String(cfg.maxPools)} onChange={(e) => set("maxPools", e.target.value)} hint="2–5 highest-TVL exact SOL/USDC pools." />
              {!chk.ok && <p role="alert" className="text-sm text-destructive">{chk.error}</p>}
              {chk.ok && (() => { try { parseConfig(cfg); return null; } catch (e) { return <p role="alert" className="text-sm text-destructive">{(e as Error).message}</p>; } })()}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn size="sm" variant="line" onClick={exportCfg}>Export JSON</Btn>
              <Btn size="sm" variant="quiet" onClick={() => setCfg(DEFAULT_CONFIG)}>Reset</Btn>
            </div>
            <label className="mt-3 block text-sm"><span className="station-code text-cream/70">Import config (v1 JSON)</span>
              <textarea className="mt-1 h-20 w-full border border-line bg-midnight p-2 font-mono text-xs" value={importText} onChange={(e) => setImportText(e.target.value)} />
            </label>
            <Btn size="sm" variant="line" className="mt-2" onClick={importCfg} disabled={!importText.trim()}>Import</Btn>
          </Panel>
        </div>

        <div className="flex flex-col gap-6">
          <Panel tone="cobalt">
            <div className="flex flex-wrap items-center gap-3">
              <Btn onClick={() => scanOnce("manual")} disabled={scanning || !!blocked || !chk.ok}>{scanning ? "Scanning…" : "Scan once"}</Btn>
              <Btn variant="line" onClick={() => setMonitor((m) => { push("info", m ? "Monitoring paused by you." : "Monitoring requested."); return !m; })} disabled={!!blocked || !chk.ok} aria-pressed={monitor}>{monitor ? "Pause monitoring" : "Start monitoring"}</Btn>
              <span className="station-code text-cream/75" role="status">{monitor ? "● Monitoring this tab" : "Monitoring off"}{scan ? ` · last scan ${Math.round((now - scan.at) / 1000)}s ago` : ""}</span>
            </div>
            {scanErr && <div className="mt-4"><Notice tone="error" title="Scan failed">{scanErr}</Notice></div>}
            {scan && now - scan.at > 60_000 && <p className="mt-3 text-sm text-amber">These results are stale (over 60s old). Scan again before acting.</p>}
            {scan && (
              <div className="mt-5">
                <h3 className="station-code text-amber">Pools · on-chain verified</h3>
                <ul className="mt-2 grid gap-1 text-sm">
                  {scan.pools.map((p) => (
                    <li key={p.address} className="flex flex-wrap gap-2"><span className={cn("station-code", p.status === "ok" && !p.reason ? "text-success" : "text-destructive")}>{p.status === "ok" && !p.reason ? "OK" : p.status.toUpperCase()}</span><span>{p.name}</span><a className="font-mono text-xs underline" href={explorerAccount(p.address, "mainnet-beta")} target="_blank" rel="noreferrer">{shortAddr(p.address, 5)}</a>{p.reason && <span className="text-xs text-cream/70">{p.reason}</span>}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          {scan && (
            <Panel>
              <h2 className="display text-2xl">Routes</h2>
              {!best && <p className="mt-2 text-sm text-cream/80" role="status">No profitable route: none of the {routes.length} quoted round trips cover input + fees + kept rent + your minimum net profit. That is the normal result.</p>}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Quoted round-trip routes</caption>
                  <thead className="station-code text-cream/65"><tr><th className="py-2">Leg A → Leg B</th><th>USDC (A min)</th><th>SOL out (exp / min)</th><th>Expected net</th><th>Verdict</th><th /></tr></thead>
                  <tbody>
                    {routes.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="py-2">{r.nameA}<br />→ {r.nameB}</td>
                        <td className="font-mono">{formatUnits(r.a.min, 6)}</td>
                        <td className="font-mono">{r.b ? `${formatUnits(r.b.out, 9)} / ${formatUnits(r.b.min, 9)}` : "—"}</td>
                        <td className="font-mono">{r.verdict.kind === "profitable" ? SOL(r.verdict.expectedProfit) : r.verdict.kind === "unprofitable" ? SOL(r.verdict.expectedProfit) : "—"}</td>
                        <td className={cn("text-xs", r.verdict.kind === "profitable" ? "text-success" : r.verdict.kind === "invalid" ? "text-destructive" : "text-cream/75")}>{r.verdict.kind === "profitable" ? "Meets floor" : r.verdict.reason}</td>
                        <td>{r.verdict.kind === "profitable" && (publicKey ? <Btn size="sm" onClick={() => requote(r)} disabled={reviewing || runner.running}>{reviewing ? "Requoting…" : "Requote & Review"}</Btn> : <span className="text-xs text-cream/70">Connect wallet to review</span>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!publicKey && <div className="mt-4 flex items-center gap-3 text-sm text-cream/75"><WalletButton /> Scanning works without a wallet.</div>}
            </Panel>
          )}

          {revErr && <Notice tone="warn" title="Review unavailable">{revErr}</Notice>}
          {review && (
            <Panel tone="cobalt">
              <h2 className="display text-2xl">Review · one atomic transaction</h2>
              <p className={cn("station-code mt-1", expired || stale ? "text-destructive" : "text-amber")}>{stale ? "Inputs changed — requote" : expired ? "Quote expired — requote" : `${Math.ceil((QUOTE_TTL_MS - (now - review.at)) / 1000)}s left`}</p>
              <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                <dt className="text-cream/70">Leg A pool</dt><dd className="font-mono">{review.route.nameA} · {shortAddr(review.a.pool, 5)}</dd>
                <dt className="text-cream/70">Input consumed</dt><dd className="font-mono">{SOL(review.a.consumed)}</dd>
                <dt className="text-cream/70">Leg A expected / min</dt><dd className="font-mono">{USDC(review.a.out)} / {USDC(review.a.min)}</dd>
                <dt className="text-cream/70">Leg A DLMM fee (in quote)</dt><dd className="font-mono">{SOL(review.a.fee)} · impact {fmtPct(Number(review.a.impactPct))}</dd>
                <dt className="text-cream/70">Leg B pool</dt><dd className="font-mono">{review.route.nameB} · {shortAddr(review.b.pool, 5)}</dd>
                <dt className="text-cream/70">Leg B input (= A min)</dt><dd className="font-mono">{USDC(review.b.consumed)}</dd>
                <dt className="text-cream/70">Leg B expected / quote min</dt><dd className="font-mono">{SOL(review.b.out)} / {SOL(review.b.min)}</dd>
                <dt className="text-cream/70">Leg B DLMM fee (in quote)</dt><dd className="font-mono">{USDC(review.b.fee)} · impact {fmtPct(Number(review.b.impactPct))}</dd>
                <dt className="text-cream/70">Enforced SOL floor</dt><dd className="font-mono text-amber">{SOL(BN.max(review.floor, review.b.min))}</dd>
                <dt className="text-cream/70">Base network fee</dt><dd className="font-mono">{SOL(review.costs.baseFee)}</dd>
                <dt className="text-cream/70">Priority fee (max)</dt><dd className="font-mono">{SOL(review.costs.priorityFee)}</dd>
                <dt className="text-cream/70">New USDC account rent (kept)</dt><dd className="font-mono">{SOL(review.costs.nonRefundableRent)}</dd>
                <dt className="text-cream/70">Temporary WSOL rent (returned)</dt><dd className="font-mono">{SOL(review.costs.refundableRent)}</dd>
                <dt className="text-cream/70">Residual USDC dust (expected)</dt><dd className="font-mono">{USDC(review.residualUsdc)}</dd>
                <dt className="text-cream/70">Expected net SOL</dt><dd className="font-mono">{SOL(review.expectedProfit)}</dd>
                <dt className="text-cream/70">Conservative net SOL</dt><dd className="font-mono text-success">{SOL(review.conservativeProfit)}</dd>
                <dt className="text-cream/70">Size / programs</dt><dd className="font-mono text-xs">{review.built.bytes} B · {review.built.programs.length} programs</dd>
              </dl>
              <p className="mt-3 text-xs text-cream/75">WSOL account: {review.w.wsolExists ? "existing — not closed; output SOL stays wrapped there" : "created and closed in this transaction"}. USDC account: {review.w.usdcExists ? "existing — never closed or drained" : "created and kept (holds residual dust)"}. The exact message is simulated before your wallet opens; if simulation fails nothing is requested.</p>
              <Btn className="mt-4 w-full" onClick={approve} disabled={expired || stale || runner.running}>{runner.running ? "Working…" : "Simulate & approve in wallet"}</Btn>
            </Panel>
          )}
          <TxSteps steps={runner.steps} />
          {realized && (
            <Panel>
              <h3 className="station-code text-amber">Realized · from chain metadata</h3>
              <ul className="mt-2 text-sm">{realized.text.map((t) => <li key={t} className="font-mono">{t}</li>)}</ul>
              <a className="station-code mt-2 inline-block text-amber underline" href={explorerTx(realized.sig, "mainnet-beta")} target="_blank" rel="noreferrer">View on explorer ↗</a>
            </Panel>
          )}

          <Panel>
            <div className="flex items-center justify-between"><h3 className="station-code text-amber">Activity journal</h3><Btn size="sm" variant="quiet" onClick={() => setLog([])}>Clear</Btn></div>
            {log.length === 0 ? <p className="mt-2 text-sm text-cream/70">Nothing yet. Run a scan.</p> : (
              <ol className="mt-2 max-h-72 overflow-auto text-xs" aria-live="polite">
                {log.map((l, i) => <li key={i} className={cn("border-t border-line py-1", l.tone === "error" && "text-destructive", l.tone === "warn" && "text-amber", l.tone === "ok" && "text-success")}><span className="font-mono text-cream/55">{new Date(l.at).toLocaleTimeString()}</span> {l.text}</li>)}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

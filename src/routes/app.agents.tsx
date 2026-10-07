import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Btn, Cap, Field, Notice, PageHead, Panel, Segmented, Spinner, Stat } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { CheckStatus, TxSteps, useTxRunner } from "@/components/app/useTx";
import { fetchPositionRows, type PositionRow } from "@/components/app/positions";
import { formatUnits } from "@/lib/amount";
import { fmtPct, fmtUsd, isBase58Address, redactUrls, shortAddr, timeAgo } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { JobCancelled, JobControl, JobTimeout } from "@/lib/job-control";
import { MAX_UI_BINS, STRATEGIES, type StrategyName } from "@/lib/strategy";
import { feeTvlPct, v24 } from "@/lib/meteora-api";
import {
  DEFAULT_RULE, REVIEW_TTL_MS, balancedTarget, SUPPORTED_COMMANDS, allocation, armRule, disarmRule, editRule, evaluate, observeOut, observedMs,
  parseCommand, parseRuleStore, pctMoveBetweenBins, propose, rebaseAfterConfirmedRebalance, reviewStaleReason, rpcIdentity,
  rulesStorageKey, spendRefusal, type AgentMode, type BinLite, type FrozenReview, type LiveIdentity, type OutRun, type Proposal,
  type Rule, type RuleParams, type VolReading,
} from "@/lib/agents";
import { buildNativeRebalance, buildWithdraw, discoverSamePair, readVolatility, type BuiltRebalance, type BuiltWithdraw, type PairScan } from "@/lib/agents-chain";
import { PRACTICE_OWNER, practiceRow } from "@/lib/agents-practice";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

export const Route = createFileRoute("/app/agents")({
  head: () => ({
    meta: [
      { title: "Liquidity Agents · The Observatory — Studio Loco" },
      { name: "description", content: "Arm range, capital and risk rules on your Meteora DLMM positions. The agent observes in this tab and proposes; your wallet approves every move." },
      { property: "og:title", content: "Liquidity Agents · The Observatory — Studio Loco" },
      { property: "og:description", content: "Rule-based observation of real DLMM positions with reviewable rebalance and withdrawal proposals. No auto-signing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Agents,
});

const POLL_MS = 30_000;
const MAX_GAP_MS = 75_000;

/** Unified row used by live, watch-only and practice views. */
interface ViewRow { key: string; pair: string; activeId: number; lower: number; upper: number; binStep: number; mintX: string; mintY: string; decX: number; decY: number; bins: BinLite[] | null; totalX: string; totalY: string; label: string }

function fromLive(r: PositionRow): ViewRow {
  const d = r.position.positionData;
  return { key: r.key, pair: r.pair, activeId: r.activeId, lower: r.lower, upper: r.upper, binStep: r.binStep, mintX: r.mintX, mintY: r.mintY, decX: r.decX, decY: r.decY,
    bins: Array.isArray(d.positionBinData) ? d.positionBinData.map((b) => ({ binId: b.binId, positionXAmount: b.positionXAmount, positionYAmount: b.positionYAmount })) : null,
    totalX: d.totalXAmount.split(".")[0] ?? "", totalY: d.totalYAmount.split(".")[0] ?? "", label: `Pool ${shortAddr(r.pair)}` };
}

interface HistoryItem { t: number; kind: "check" | "proposal" | "review" | "tx" | "rule" | "error"; text: string }

type Review =
  | { state: "building"; proposal: Proposal }
  | { state: "error"; proposal: Proposal; error: string }
  | { state: "staged"; proposal: Proposal; reason: string }
  | { state: "ready"; proposal: Proposal; frozen: FrozenReview; built: { kind: "rebalance"; b: BuiltRebalance } | { kind: "withdraw"; b: BuiltWithdraw; staged?: { targetPool: string; width: number; strategy: StrategyName } } }
  | { state: "practice"; proposal: Proposal };

function Agents() {
  const { settings } = useSettings();
  const wallet = useWallet();
  const { connection } = useConnection();
  const runner = useTxRunner();
  const [mode, setMode] = useState<AgentMode>("wallet");
  const [watchInput, setWatchInput] = useState("");
  const [watchAddr, setWatchAddr] = useState<string | null>(null);
  const rpcId = rpcIdentity(settings.rpc[settings.cluster]);
  const owner = mode === "practice" ? PRACTICE_OWNER : mode === "watch" ? watchAddr : wallet.publicKey?.toBase58() ?? null;
  const scopeRpc = mode === "practice" ? "practice" : rpcId;
  const storeKey = owner ? rulesStorageKey(owner, mode === "practice" ? "practice" : settings.cluster, scopeRpc) : null;
  const histKey = storeKey ? storeKey.replace("agent-rules", "agent-history") : null;

  const [rows, setRows] = useState<ViewRow[] | null>(null);
  const [report, setReport] = useState<{ rejected: number; truncated: boolean } | null>(null);
  const [load, setLoad] = useState<{ phase: "idle" | "loading" | "ok" | "error"; error?: string; at?: number }>({ phase: "idle" });
  const [rules, setRules] = useState<Record<string, Rule>>({});
  const [vol, setVol] = useState<Record<string, VolReading>>({});
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [monitoring, setMonitoring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [practiceStep, setPracticeStep] = useState(0);
  const [staged, setStaged] = useState<{ pool: string; width: number; strategy: StrategyName; cluster: "mainnet-beta" | "devnet" } | null>(null);
  const outRuns = useRef<Record<string, OutRun | undefined>>({});
  const lastProposed = useRef<Record<string, number>>({});
  const pendingRebase = useRef<Set<string>>(new Set());
  const genRef = useRef(0);
  const ctl = useRef<JobControl | null>(null);
  if (!ctl.current) ctl.current = new JobControl();
  const [, force] = useState(0);
  useEffect(() => ctl.current!.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => { const c = ctl.current!; c.mounted = true; return () => c.unmount(); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const addHistory = useCallback((kind: HistoryItem["kind"], text: string) => {
    setHistory((h) => [{ t: Date.now(), kind, text: redactUrls(text) }, ...h].slice(0, 100));
  }, []);

  // Identity changes invalidate everything immediately.
  const identity = `${mode}|${owner}|${settings.cluster}|${rpcId}|${settings.practice}|${settings.slippageBps}`;
  useEffect(() => {
    genRef.current++;
    ctl.current!.invalidate();
    setMonitoring(false); setReview(null); setRows(null); setReport(null); setProposals([]); setVol({}); setLoad({ phase: "idle" }); setStaged(null);
    outRuns.current = {}; lastProposed.current = {};
  }, [identity]);

  // Load scoped rules + history.
  useEffect(() => {
    if (!storeKey) { setRules({}); setHistory([]); return; }
    try { setRules(parseRuleStore(JSON.parse(localStorage.getItem(storeKey) ?? "null"))); } catch { setRules({}); }
    try { const h = JSON.parse(localStorage.getItem(histKey!) ?? "[]"); setHistory(Array.isArray(h) ? h.filter((x) => x && typeof x.t === "number" && typeof x.text === "string").slice(0, 100) : []); } catch { setHistory([]); }
  }, [storeKey, histKey]);
  const saveRules = (next: Record<string, Rule>) => {
    setRules(next);
    genRef.current++;
    if (storeKey) try { localStorage.setItem(storeKey, JSON.stringify({ v: 1, rules: next })); } catch { /* quota */ }
  };
  useEffect(() => { if (histKey) try { localStorage.setItem(histKey, JSON.stringify(history)); } catch { /* */ } }, [history, histKey]);

  const live = useRef<LiveIdentity & { rules: Record<string, Rule>; rowKeys: Set<string> }>(null as never);
  live.current = { ruleRevision: undefined, wallet: wallet.publicKey?.toBase58() ?? "", cluster: settings.cluster, rpcId, practiceSetting: settings.practice, mode, slippageBps: settings.slippageBps, gen: genRef.current, positionPresent: false, rules, rowKeys: new Set((rows ?? []).map((r) => r.key)) };
  const liveFor = (position: string): LiveIdentity => ({ ...live.current, ruleRevision: live.current.rules[position]?.revision ?? -1, positionPresent: live.current.rowKeys.has(position) });

  const refusal = spendRefusal({ mode, practiceSetting: settings.practice, canSign: runner.canSign });
  const unresolved = runner.steps?.find((s) => s.phase === "unknown")?.pending ?? null;

  /* ---------- the check: read-only, bounded, single-flight ---------- */
  const runCheck = useCallback(async (source: "manual" | "monitor") => {
    const c = ctl.current!;
    const job = c.begin();
    if (!job) { if (source === "manual") addHistory("error", c.draining ? "A timed-out request is still draining; try again shortly." : "A check is already running."); return; }
    setLoad((l) => ({ ...l, phase: "loading", error: undefined }));
    try {
      let next: ViewRow[];
      let rep: { rejected: number; truncated: boolean } | null = null;
      if (mode === "practice") {
        const step = source === "manual" || monitoring ? practiceStep + 1 : practiceStep;
        setPracticeStep(step);
        next = [{ ...practiceRow(step), totalX: "", totalY: "" }].map((r) => ({ ...r, totalX: r.bins.reduce((a, b) => a + BigInt(b.positionXAmount), 0n).toString(), totalY: r.bins.reduce((a, b) => a + BigInt(b.positionYAmount), 0n).toString() }));
      } else {
        if (!owner) throw new Error("No address selected");
        const { PublicKey } = await import("@solana/web3.js");
        const got = await job.step(fetchPositionRows(connection, new PublicKey(owner), settings.cluster, job.signal), 30_000, "Position discovery");
        rep = got.report ? { rejected: got.report.rejected, truncated: got.report.truncated } : null;
        next = got.map(fromLive);
      }
      // Volatility only for pools whose armed rule asks for it.
      const vr: Record<string, VolReading> = {};
      for (const r of next) {
        const rule = rules[r.key];
        if (!rule?.armed || !rule.volatility) continue;
        if (mode === "practice") { vr[r.pair] = { state: "unavailable", reason: "Practice scenario has no price history." }; continue; }
        vr[r.pair] = await job.step(readVolatility(r.pair, settings.cluster, rule.volatility.frame, rule.volatility.candles, job.signal), 15_000, "Price history");
      }
      job.check();
      const t = Date.now();
      // Observations: continuity requires a gap no larger than MAX_GAP_MS.
      const runs: Record<string, OutRun | undefined> = {};
      for (const r of next) runs[r.key] = observeOut(outRuns.current[r.key], r.activeId < r.lower || r.activeId > r.upper, t, MAX_GAP_MS);
      outRuns.current = runs;
      // Confirmed-rebalance re-anchoring happens on the first fresh read after confirmation.
      let ruleMap = rules;
      for (const k of [...pendingRebase.current]) {
        const r = next.find((x) => x.key === k);
        if (r && ruleMap[k]?.armed) { ruleMap = { ...ruleMap, [k]: rebaseAfterConfirmedRebalance(ruleMap[k]!, r.activeId, r.binStep, t) }; addHistory("rule", `Baseline re-anchored at bin ${r.activeId} after a confirmed rebalance of ${shortAddr(k)}.`); }
        pendingRebase.current.delete(k);
      }
      if (ruleMap !== rules) saveRules(ruleMap);
      const fresh: Proposal[] = [];
      for (const r of next) {
        const rule = ruleMap[r.key];
        if (!rule) continue;
        const p = propose({ rule, pos: { key: r.key, pool: r.pair, activeId: r.activeId, lower: r.lower, upper: r.upper, binStep: r.binStep }, outRun: runs[r.key], vol: vr[r.pair] ?? null, now: t }, lastProposed.current);
        if (p) { lastProposed.current[p.id] = t; fresh.push(p); }
      }
      setRows(next); setReport(rep); setVol((v) => ({ ...v, ...vr }));
      setProposals((q) => [...fresh, ...q.filter((x) => !fresh.some((f) => f.id === x.id) && next.some((r) => r.key === x.position))].slice(0, 20));
      for (const p of fresh) addHistory("proposal", `${p.kind === "reduce" ? `Reduce ${p.withdrawPct}%` : "Rebalance"} proposed for ${shortAddr(p.position)}: ${p.reason}`);
      addHistory("check", `${source === "monitor" ? "Monitor" : "Manual"} check: ${next.length} verified position(s)${rep?.rejected ? `, ${rep.rejected} rejected` : ""}${rep?.truncated ? ", index truncated" : ""}.`);
      setLoad({ phase: "ok", at: t });
      setSelected((s) => s ?? next[0]?.key ?? null);
    } catch (e) {
      if (e instanceof JobCancelled) return;
      if (job.alive() || e instanceof JobTimeout) {
        const msg = redactUrls(e instanceof Error ? e.message : String(e));
        const rate = /429|rate/i.test(msg);
        setLoad({ phase: "error", error: rate ? `Rate limited by the data source. ${msg}` : msg });
        addHistory("error", `Check failed: ${msg}`);
      }
    } finally {
      c.end(job);
    }
  }, [mode, owner, connection, settings.cluster, rules, monitoring, practiceStep, addHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Monitoring loop (in-tab only). Pauses when hidden or while reviewing/signing.
  const checkRef = useRef(runCheck); checkRef.current = runCheck;
  useEffect(() => {
    if (!monitoring) return;
    void checkRef.current("monitor");
    const t = setInterval(() => { if (!ctl.current!.busy) void checkRef.current("monitor"); }, POLL_MS);
    const vis = () => { if (document.hidden) { ctl.current!.invalidate(); setMonitoring(false); addHistory("check", "Monitoring paused: tab hidden. Hidden time is not counted as observed."); } };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [monitoring, addHistory]);
  const pause = () => { genRef.current++; ctl.current!.invalidate(); setMonitoring(false); addHistory("check", "Monitoring paused."); };

  /* ---------- reviews ---------- */
  async function prepare(p: Proposal, opts: { stagedTo?: { pool: string } } = {}) {
    if (mode === "practice") { setReview({ state: "practice", proposal: p }); addHistory("review", `Practice review opened for ${p.kind}. Nothing can be signed.`); return; }
    if (refusal) { setReview({ state: "error", proposal: p, error: refusal }); return; }
    if (unresolved) { setReview({ state: "error", proposal: p, error: "A previous transaction's settlement is unresolved. Check its status first." }); return; }
    if (monitoring) pause();
    genRef.current++;
    ctl.current!.invalidate();
    const c = ctl.current!;
    const job = c.begin();
    if (!job) { setReview({ state: "error", proposal: p, error: "A timed-out request is still draining. Try again in a moment." }); return; }
    setReview({ state: "building", proposal: p });
    const gen = genRef.current;
    const ownerPk = wallet.publicKey!;
    const rule = rules[p.position];
    try {
      const builtAt = Date.now();
      const base = { ruleRevision: rule?.revision ?? -1, wallet: ownerPk.toBase58(), cluster: settings.cluster, rpcId, pool: p.pool, position: p.position, slippageBps: settings.slippageBps, builtAt, gen };
      if (p.kind === "rebalance" && !opts.stagedTo) {
        const r = await job.step(buildNativeRebalance({ connection, owner: ownerPk, poolAddress: p.pool, position: p.position, strategy: rule?.strategy ?? "Spot", slippageBps: settings.slippageBps, cluster: settings.cluster }), 60_000, "Rebalance build");
        if (!r.ok) { setReview({ state: "staged", proposal: p, reason: r.reason }); addHistory("review", `Native rebalance not possible for ${shortAddr(p.position)}: ${r.reason}`); return; }
        const b = r.built;
        const frozen: FrozenReview = { ...base, builtAt: Date.now(), action: "rebalance", targetLower: b.target.lower, targetUpper: b.target.upper, feeLamports: b.costs.perTxFee[0] ?? null, solOutLamports: b.costs.solOutLamports };
        setReview({ state: "ready", proposal: p, frozen, built: { kind: "rebalance", b } });
        addHistory("review", `Rebalance review built: target ${b.target.lower}–${b.target.upper}, ${b.kind}${b.costs.simErrors[0] ? `, simulation failed: ${b.costs.simErrors[0]}` : ", simulated OK"}.`);
      } else {
        const pct = opts.stagedTo ? 100 : p.withdrawPct ?? 100;
        const b = await job.step(buildWithdraw({ connection, owner: ownerPk, poolAddress: p.pool, position: p.position, bps: pct * 100, cluster: settings.cluster, label: opts.stagedTo ? "Stage 1 · Withdraw 100% (position stays open)" : `Withdraw ${pct}%` }), 60_000, "Withdraw build");
        const row = rows?.find((x) => x.key === p.position);
        const frozen: FrozenReview = { ...base, builtAt: Date.now(), action: "withdraw", withdrawBps: pct * 100, feeLamports: b.costs.perTxFee[0] ?? null, solOutLamports: b.costs.solOutLamports };
        setReview({ state: "ready", proposal: p, frozen, built: { kind: "withdraw", b, staged: opts.stagedTo && row ? { targetPool: opts.stagedTo.pool, width: row.upper - row.lower + 1, strategy: rule?.strategy ?? "Spot" } : undefined } });
        addHistory("review", `Withdrawal review built (${pct}%)${b.costs.simErrors[0] ? `, simulation failed: ${b.costs.simErrors[0]}` : ", simulated OK"}.`);
      }
    } catch (e) {
      if (e instanceof JobCancelled) return;
      if (genRef.current === gen || e instanceof JobTimeout) setReview({ state: "error", proposal: p, error: redactUrls(e instanceof Error ? e.message : String(e)) });
    } finally { c.end(job); }
  }

  async function approve(rv: Extract<Review, { state: "ready" }>) {
    const why = reviewStaleReason(rv.frozen, liveFor(rv.proposal.position), Date.now());
    if (why) return;
    const first = rv.built.b.txs[0];
    if (!first) return;
    addHistory("tx", `Wallet approval requested: ${first.label}.`);
    let steps;
    try {
      steps = await runner.run([first], { semanticGuard: () => reviewStaleReason(rv.frozen, liveFor(rv.proposal.position), Date.now()), maxFeeLamports: rv.frozen.feeLamports ?? undefined });
    } catch (e) { addHistory("error", e instanceof Error ? e.message : String(e)); return; }
    const s = steps[0];
    addHistory("tx", `${first.label}: ${s?.phase ?? "not run"}${s?.signature ? ` · ${shortAddr(s.signature, 6)}` : ""}${s?.error ? ` — ${s.error}` : ""}`);
    genRef.current++;
    if (s?.phase === "confirmed") {
      const remaining = rv.built.b.costs.remaining;
      if (rv.built.kind === "rebalance" && remaining === 0) pendingRebase.current.add(rv.proposal.position);
      if (rv.built.kind === "withdraw" && rv.built.staged && remaining === 0) setStaged({ pool: rv.built.staged.targetPool, width: rv.built.staged.width, strategy: rv.built.staged.strategy, cluster: settings.cluster });
      setProposals((q) => (remaining === 0 ? q.filter((x) => x.id !== rv.proposal.id) : q));
      if (remaining > 0) addHistory("tx", `${remaining} more step(s) remain. Build a fresh review to continue — nothing continues automatically.`);
      setReview(null);
      void runCheck("manual");
    }
  }

  const sel = rows?.find((r) => r.key === selected) ?? null;
  const selRule = sel ? rules[sel.key] ?? DEFAULT_RULE : null;
  const updateRule = (k: string, f: (r: Rule) => Rule, note: string) => {
    try { const n = f(rules[k] ?? DEFAULT_RULE); saveRules({ ...rules, [k]: n }); addHistory("rule", note); setReview((rv) => (rv && rv.proposal.position === k ? null : rv)); } catch (e) { addHistory("error", e instanceof Error ? e.message : String(e)); }
  };

  const status = mode === "practice" ? "Practice scenario" : mode === "watch" ? "Watch-only" : settings.practice ? "Practice setting on — live spending disabled" : wallet.publicKey ? "Live wallet" : "Disconnected";
  const canCheck = mode === "practice" || !!owner;
  const reviewing = review?.state === "building" || review?.state === "ready" || runner.running;

  return (
    <div>
      <div className="relative mb-6 overflow-hidden border border-line">
        <img src={nightAsset.url} alt="A midnight train with amber windows waits at a station under a cobalt sky" className="h-40 w-full object-cover md:h-56" loading="eager" />
        <div className="absolute inset-0 bg-gradient-to-t from-midnight via-midnight/40 to-transparent" />
        <p className="absolute bottom-3 left-4 station-code text-cream">ST-07 · The Observatory · rule-based observation</p>
      </div>
      <PageHead code="ST-07 · Liquidity Agents" title="The Observatory." intro="Arm rules on real DLMM positions. The agent observes while this tab is open and prepares proposals; your wallet approves every move. No keeper, no auto-signing, no forecasts." cap={mode === "practice" ? ["practice"] : ["live"]} />

      <Panel className="mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <Segmented<AgentMode> label="Mode" value={mode} onChange={setMode} options={[{ value: "wallet", label: "My wallet" }, { value: "watch", label: "Watch-only" }, { value: "practice", label: "Practice scenario" }]} />
          <div className="flex flex-col"><span className="station-code text-cream/60">Status</span><span className={cn("station-code mt-1 border px-2 py-1", mode === "practice" ? "border-ochre text-ochre" : mode === "watch" ? "border-cream/60" : wallet.publicKey && !settings.practice ? "border-success text-success" : "border-amber text-amber")}>{status}</span></div>
          <div className="flex flex-col"><span className="station-code text-cream/60">Monitor</span><span className="station-code mt-1">{monitoring ? `Watching · every ${POLL_MS / 1000}s` : "Paused"}{ctl.current!.draining ? " · draining" : ""}</span></div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Btn size="sm" variant="line" disabled={!canCheck || ctl.current!.busy || reviewing} onClick={() => runCheck("manual")}>{load.phase === "loading" ? "Checking…" : "Run check"}</Btn>
            {monitoring ? <Btn size="sm" onClick={pause}>Pause monitoring</Btn> : <Btn size="sm" disabled={!canCheck || reviewing || ctl.current!.draining} onClick={() => { setMonitoring(true); addHistory("check", "Monitoring started in this tab."); }}>Start monitoring</Btn>}
          </div>
        </div>
        {mode === "watch" && (
          <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (isBase58Address(watchInput)) setWatchAddr(watchInput.trim()); }}>
            <div className="min-w-[280px] flex-1"><Field label="Public address to inspect" value={watchInput} onChange={(e) => setWatchInput(e.target.value)} error={watchInput && !isBase58Address(watchInput) ? "Not a Solana address" : null} hint="Read-only. This mode can never transact." /></div>
            <Btn size="sm" type="submit" disabled={!isBase58Address(watchInput)}>Inspect</Btn>
          </form>
        )}
        {mode === "practice" && <p className="mt-3 text-sm text-ochre">Practice scenario: one fictional TRAIN/USDC position whose price follows a fixed script. Each check advances the script. It never reaches the transaction builder or your wallet.</p>}
        {mode === "wallet" && settings.practice && <p className="mt-3 text-sm text-amber">Practice is on in Settings, so every live spending path is disabled here.</p>}
      </Panel>

      {mode === "wallet" && !wallet.publicKey ? <EmptyState onPractice={() => setMode("practice")} onWatch={() => setMode("watch")} />
        : mode === "watch" && !watchAddr ? <Panel><p className="text-cream/80">Enter a public address to inspect its DLMM positions read-only.</p></Panel>
        : (
          <>
            {load.phase === "error" && <Notice tone="error" title="Check failed" action={<Btn size="sm" onClick={() => runCheck("manual")}>Retry</Btn>}>{load.error}. Nothing was assumed; previous readings are shown as of their own time.</Notice>}
            {report?.truncated && <Notice tone="warn" title="Incomplete index">Meteora's index returned fewer positions than it reported. Some positions may be missing.</Notice>}
            {report && report.rejected > 0 && <Notice tone="warn" title={`${report.rejected} position(s) failed on-chain verification`}>They are hidden and cannot be acted on.</Notice>}
            {!rows && load.phase !== "loading" && load.phase !== "error" && <Panel><p className="text-cream/80">Press <strong>Run check</strong> to read {mode === "practice" ? "the practice position" : "verified positions"}.</p></Panel>}
            {!rows && load.phase === "loading" && <Spinner label="Reading verified positions" />}
            {rows && rows.length === 0 && <Panel><p className="text-cream/80">No verified DLMM positions on this network. <Link to="/app" className="underline">Open a pool</Link> or try the practice scenario.</p></Panel>}
            {rows && rows.length > 0 && (
              <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
                <div className="flex flex-col gap-4">
                  <p className="station-code text-cream/60">Last check {load.at ? timeAgo(load.at) : "—"}{load.at && now - load.at > 2 * POLL_MS ? " · stale" : ""}</p>
                  {rows.map((r) => <PositionCard key={r.key} r={r} rule={rules[r.key]} vol={vol[r.pair]} outRun={outRuns.current[r.key]} selected={selected === r.key} onSelect={() => setSelected(r.key)} />)}
                </div>
                <div className="flex flex-col gap-6">
                  {sel && selRule && <RuleEditor key={sel.key + selRule.revision} row={sel} rule={selRule} canArm={!reviewing}
                    onSave={(patch) => updateRule(sel.key, (r) => editRule(r, patch), `Rule for ${shortAddr(sel.key)} edited (now disarmed; arm to capture a baseline).`)}
                    onArm={() => updateRule(sel.key, (r) => armRule(r, sel.activeId, sel.binStep, Date.now()), `Rule armed for ${shortAddr(sel.key)} with baseline bin ${sel.activeId}.`)}
                    onDisarm={() => updateRule(sel.key, disarmRule, `Rule disarmed for ${shortAddr(sel.key)}.`)} />}
                </div>
              </div>
            )}

            <section className="mt-8" aria-labelledby="queue-h">
              <h2 id="queue-h" className="display mb-3 text-2xl">Proposal queue</h2>
              {proposals.length === 0 ? <p className="text-sm text-cream/70">No proposals. Proposals appear only from armed rules, deduplicated per trigger with a cooldown.</p> : (
                <ul className="flex flex-col gap-3">
                  {proposals.map((p) => (
                    <li key={p.id} className="ticket p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{p.kind === "reduce" ? `Reduce · withdraw ${p.withdrawPct}%` : `Rebalance → bins ${p.target?.lower}–${p.target?.upper}`} · {shortAddr(p.position)}</span>
                        <span className="station-code text-cream/60">{p.trigger} · {timeAgo(p.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-sm text-cream/80">{p.reason}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Btn size="sm" disabled={reviewing || (mode !== "practice" && !!refusal)} onClick={() => prepare(p)}>Prepare review</Btn>
                        <Btn size="sm" variant="ghost" onClick={() => { setProposals((q) => q.filter((x) => x.id !== p.id)); addHistory("proposal", `Dismissed ${p.kind} for ${shortAddr(p.position)}.`); }}>Dismiss</Btn>
                      </div>
                      {mode !== "practice" && refusal && <p className="mt-2 text-xs text-amber">{refusal}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {review && <ReviewPanel review={review} now={now} stale={review.state === "ready" ? reviewStaleReason(review.frozen, liveFor(review.proposal.position), now) : null} running={runner.running}
              onApprove={() => review.state === "ready" && approve(review)} onRebuild={() => prepare(review.proposal, review.state === "ready" && review.built.kind === "withdraw" && review.built.staged ? { stagedTo: { pool: review.built.staged.targetPool } } : {})}
              onStage={(pool) => prepare({ ...review.proposal, kind: "reduce" }, { stagedTo: { pool } })} onClose={() => setReview(null)} row={rows?.find((r) => r.key === review.proposal.position) ?? null} />}
            <TxSteps steps={runner.steps} />
            {unresolved && <div className="mt-3"><CheckStatus p={unresolved} onResolved={() => runner.reset()} /></div>}
            {staged && (
              <Notice tone="info" title="Stage 1 confirmed — continue with a fresh add">
                Withdrawal confirmed. Stage 2 opens the add-liquidity review for the chosen pool on {staged.cluster === "devnet" ? "devnet" : "mainnet"}; you review amounts against your fresh balance and sign separately. This is not atomic.
                {staged.width > MAX_UI_BINS && <> Your range was {staged.width} bins; the add flow opens at most {MAX_UI_BINS} bins, so it will be narrower.</>}
                <div className="mt-2"><Link to="/app/pool/$address" params={{ address: staged.pool }} search={{ tab: "add", strategy: staged.strategy, below: Math.floor((Math.min(staged.width, MAX_UI_BINS) - 1) / 2), above: Math.min(staged.width, MAX_UI_BINS) - 1 - Math.floor((Math.min(staged.width, MAX_UI_BINS) - 1) / 2), cluster: staged.cluster }} className="underline">Continue to stage 2 →</Link></div>
              </Notice>
            )}

            {sel && <Capital row={sel} cluster={settings.cluster} practice={mode === "practice"} onStage={(pool) => {
              const p: Proposal = { id: `${sel.key}:move:${pool}`, position: sel.key, pool: sel.pair, kind: "reduce", trigger: "edge", reason: `Staged move to ${shortAddr(pool)} chosen from the same-pair comparison.`, withdrawPct: 100, ruleRevision: rules[sel.key]?.revision ?? -1, createdAt: Date.now() };
              void prepare(p, { stagedTo: { pool } });
            }} disabled={reviewing || (mode !== "practice" && !!refusal)} />}

            <section className="mt-8" aria-labelledby="hist-h">
              <h2 id="hist-h" className="display mb-3 text-2xl">Activity</h2>
              {history.length === 0 ? <p className="text-sm text-cream/70">No activity yet.</p> : (
                <ol className="max-h-80 overflow-y-auto border border-line">
                  {history.map((h, i) => <li key={i} className="flex gap-3 border-b border-line px-3 py-2 text-sm last:border-0"><span className="station-code w-20 shrink-0 text-cream/55">{new Date(h.t).toLocaleTimeString()}</span><span className={cn("station-code w-16 shrink-0", h.kind === "error" ? "text-destructive" : h.kind === "tx" ? "text-amber" : "text-cream/60")}>{h.kind}</span><span className="text-cream/85">{h.text}</span></li>)}
                </ol>
              )}
              <p className="mt-2 text-xs text-cream/60">History records what this tab observed and what the runner reported. It is stored in this browser only, scoped to the address, network and RPC.</p>
            </section>
          </>
        )}
      <p className="mt-8 text-xs text-cream/60">Ordinary Meteora DLMM. Rules cannot prevent losses or impermanent loss and do not control pool fees. Time is counted only while this tab observes. See also <Link to="/app/signals" className="underline">Signals</Link>, <Link to="/app/portfolio" className="underline">Portfolio</Link> and <Link to="/app/dispatch" className="underline">Dispatch</Link>.</p>
    </div>
  );
}

function EmptyState({ onPractice, onWatch }: { onPractice: () => void; onWatch: () => void }) {
  return (
    <Panel tone="cobalt">
      <h2 className="display text-2xl">Connect to watch your carriages.</h2>
      <p className="mt-2 max-w-2xl text-cream/85">Liquidity Agents read your verified DLMM positions, evaluate rules you arm, and prepare proposals. Example rules:</p>
      <ul className="mt-3 flex flex-col gap-1 font-mono text-sm text-amber">{SUPPORTED_COMMANDS.slice(0, 4).map((c) => <li key={c}>“{c}”</li>)}</ul>
      <div className="mt-5 flex flex-wrap gap-3"><WalletButton /><Btn variant="line" onClick={onWatch}>Inspect an address (watch-only)</Btn><Btn variant="ghost" onClick={onPractice}>Explore a practice scenario</Btn></div>
    </Panel>
  );
}

function PositionCard({ r, rule, vol, outRun, selected, onSelect }: { r: ViewRow; rule?: Rule; vol?: VolReading; outRun?: OutRun; selected: boolean; onSelect: () => void }) {
  const out = r.activeId < r.lower || r.activeId > r.upper;
  const ev = rule ? evaluate({ rule, pos: { key: r.key, pool: r.pair, activeId: r.activeId, lower: r.lower, upper: r.upper, binStep: r.binStep }, outRun, vol: vol ?? null, now: Date.now() }) : null;
  const target = rule && ev?.triggers.find((t) => t.kind !== "out-time" && t.kind !== "volatility") ? balancedTarget(r.activeId, r.upper - r.lower + 1) : null;
  return (
    <Panel className={cn(selected && "outline outline-2 outline-amber")}>
      <button type="button" onClick={onSelect} className="block w-full text-left" aria-pressed={selected}>
        <div className="flex flex-wrap justify-between gap-2">
          <div><p className="font-medium">{r.label}</p><p className="station-code text-cream/60">Position {shortAddr(r.key)} · X {shortAddr(r.mintX)} ({r.decX}) · Y {shortAddr(r.mintY)} ({r.decY})</p></div>
          <span className={cn("station-code h-fit border px-2 py-1", out ? "border-destructive text-destructive" : "border-success text-success")}>{out ? "Out of range" : "In range"}</span>
        </div>
        <RangeViz lower={r.lower} upper={r.upper} active={r.activeId} buffer={rule?.edgeBuffer ?? 0} target={target} baseline={rule?.baseline?.activeId} />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Active bin" value={r.activeId} />
          <Stat label="Range" value={`${r.lower}–${r.upper}`} sub={`${r.upper - r.lower + 1} bins`} />
          <Stat label="Holdings X" value={r.totalX ? formatUnits(r.totalX, r.decX, 6) : "—"} />
          <Stat label="Holdings Y" value={r.totalY ? formatUnits(r.totalY, r.decY, 6) : "—"} />
        </div>
        <p className="mt-2 station-code text-cream/60">
          Rule: {rule ? (rule.armed ? `armed · rev ${rule.revision} · baseline bin ${rule.baseline!.activeId}${rule.baseline!.binStep === r.binStep ? ` (${pctMoveBetweenBins(rule.baseline!.activeId, r.activeId, r.binStep).toFixed(2)}% since)` : ""}` : `saved, not armed · rev ${rule.revision}`) : "none"}
          {out && ` · observed out ${Math.floor(observedMs(outRun) / 60_000)} min`}
        </p>
        {ev?.volUnknown && <p className="mt-1 text-xs text-amber">Volatility unknown — {ev.volUnknown} This is not treated as low risk.</p>}
        {vol?.state === "ok" && <p className="mt-1 text-xs text-cream/70">Observed volatility {vol.pct.toFixed(3)}% per candle (newest {timeAgo(vol.newestAt)}).</p>}
        {ev && ev.triggers.length > 0 && <ul className="mt-2 text-sm text-ochre">{ev.triggers.map((t) => <li key={t.kind}>• {t.reason}</li>)}</ul>}
      </button>
    </Panel>
  );
}

function RangeViz({ lower, upper, active, buffer, target, baseline }: { lower: number; upper: number; active: number; buffer: number; target: { lower: number; upper: number } | null; baseline?: number }) {
  const lo = Math.min(lower, active, target?.lower ?? lower, baseline ?? lower) - 3;
  const hi = Math.max(upper, active, target?.upper ?? upper, baseline ?? upper) + 3;
  const pos = (b: number) => ((b - lo) / (hi - lo + 1)) * 100;
  return (
    <div className="mt-4" role="img" aria-label={`Range ${lower} to ${upper}, active bin ${active}${target ? `, proposed target ${target.lower} to ${target.upper}` : ""}`}>
      <div className="relative h-7 border-y border-line">
        <div className="absolute inset-y-1 bg-ultramarine" style={{ left: `${pos(lower)}%`, width: `${pos(upper + 1) - pos(lower)}%` }} />
        {buffer > 0 && <><div className="absolute inset-y-1 bg-amber/30" style={{ left: `${pos(lower)}%`, width: `${pos(lower + buffer) - pos(lower)}%` }} /><div className="absolute inset-y-1 bg-amber/30" style={{ left: `${pos(upper + 1 - buffer)}%`, width: `${pos(upper + 1) - pos(upper + 1 - buffer)}%` }} /></>}
        {target && <div className="absolute -bottom-2 h-1.5 border border-dashed border-cream bg-cream/20" style={{ left: `${pos(target.lower)}%`, width: `${pos(target.upper + 1) - pos(target.lower)}%` }} />}
        {baseline !== undefined && <div className="absolute inset-y-0 w-px bg-cream/70" style={{ left: `${pos(baseline)}%` }} />}
        <div className="absolute -top-1 h-9 w-1 bg-ochre motion-safe:transition-[left] motion-safe:duration-500" style={{ left: `${pos(active)}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 station-code text-cream/60"><span>{lower}</span><span className="text-amber">active {active}</span>{target && <span>target {target.lower}–{target.upper}</span>}<span>{upper}</span></div>
    </div>
  );
}

function RuleEditor({ row, rule, onSave, onArm, onDisarm, canArm }: { row: ViewRow; rule: Rule; onSave: (p: Partial<RuleParams>) => void; onArm: () => void; onDisarm: () => void; canArm: boolean }) {
  const [cmd, setCmd] = useState("");
  const parsed = useMemo(() => (cmd.trim() ? parseCommand(cmd) : null), [cmd]);
  const [d, setD] = useState({ price: rule.priceMovePct?.toString() ?? "", edge: rule.edgeBuffer?.toString() ?? "", exit: rule.rebalanceOnExit, outMin: rule.outMinutes?.toString() ?? "", outPct: String(rule.outWithdrawPct), volOn: !!rule.volatility, frame: rule.volatility?.frame ?? "5m", candles: String(rule.volatility?.candles ?? 12), volPct: String(rule.volatility?.thresholdPct ?? 1.5), volW: String(rule.volatility?.withdrawPct ?? 25), strategy: rule.strategy as StrategyName, cooldown: String(rule.cooldownMin) });
  const [err, setErr] = useState<string | null>(null);
  const strict = (s: string, int: boolean) => { if (s.trim() === "") return null; if (!(int ? /^\d+$/ : /^\d+(\.\d+)?$/).test(s.trim())) throw new Error(`“${s}” is not a valid ${int ? "whole " : ""}number`); return Number(s); };
  const save = () => {
    try {
      const outPct = strict(d.outPct, true), cd = strict(d.cooldown, true);
      if (outPct === null || cd === null) throw new Error("Withdrawal % and cooldown are required");
      onSave({ priceMovePct: strict(d.price, false), edgeBuffer: strict(d.edge, true), rebalanceOnExit: d.exit, outMinutes: strict(d.outMin, true), outWithdrawPct: outPct, strategy: d.strategy, cooldownMin: cd,
        volatility: d.volOn ? { frame: d.frame as "5m" | "1h", candles: strict(d.candles, true) ?? NaN, thresholdPct: strict(d.volPct, false) ?? NaN, withdrawPct: strict(d.volW, true) ?? NaN } : null });
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const apply = () => { if (parsed?.ok) { try { onSave(parsed.patch); setCmd(""); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } } };
  return (
    <Panel tone="cobalt">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="display text-2xl">Rules · {shortAddr(row.key)}</h2><span className="station-code">{rule.armed ? `Armed · rev ${rule.revision}` : `Not armed · rev ${rule.revision}`}</span></div>
      <div className="mt-4">
        <label htmlFor="cmd" className="station-code">Rule assistant (deterministic grammar, not an AI model)</label>
        <textarea id="cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} rows={2} placeholder="review my range after a 5% price move; alert me within 3 bins of the edge" className="mt-1 w-full border border-input bg-midnight p-2 font-mono text-sm" />
        {parsed && !parsed.ok && <p className="mt-1 text-sm text-destructive" role="alert">{parsed.error}</p>}
        {parsed?.ok && <div className="mt-2 border border-line p-2 text-sm"><p className="station-code text-cream/60">Translated — review then apply</p><ul>{parsed.summary.map((s) => <li key={s}>• {s}</li>)}</ul><Btn size="sm" className="mt-2" onClick={apply}>Apply to parameters</Btn></div>}
        <details className="mt-2 text-xs text-cream/70"><summary className="cursor-pointer">Supported commands</summary><ul className="mt-1 font-mono">{SUPPORTED_COMMANDS.map((c) => <li key={c}>{c}</li>)}</ul><p className="mt-1">Separate clauses with “;”. Volatility = standard deviation of close-to-close log returns of real mainnet candles; needs N+1 fresh candles.</p></details>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Price move from baseline" suffix="%" value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} hint="Empty = off" inputMode="decimal" />
        <Field label="Edge buffer" suffix="bins" value={d.edge} onChange={(e) => setD({ ...d, edge: e.target.value })} hint="Empty = off" inputMode="numeric" />
        <Field label="Out of range for" suffix="min" value={d.outMin} onChange={(e) => setD({ ...d, outMin: e.target.value })} hint="Observed time only; empty = off" inputMode="numeric" />
        <Field label="…then withdraw" suffix="%" value={d.outPct} onChange={(e) => setD({ ...d, outPct: e.target.value })} inputMode="numeric" />
        <Field label="Cooldown per trigger" suffix="min" value={d.cooldown} onChange={(e) => setD({ ...d, cooldown: e.target.value })} inputMode="numeric" />
        <div><span className="station-code">Rebalance distribution</span><div className="mt-1"><Segmented<StrategyName> label="Distribution" value={d.strategy} onChange={(s) => setD({ ...d, strategy: s })} options={STRATEGIES.map((s) => ({ value: s, label: s }))} /></div></div>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.exit} onChange={(e) => setD({ ...d, exit: e.target.checked })} /> Propose a rebalance when the active bin leaves the range</label>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={d.volOn} onChange={(e) => setD({ ...d, volOn: e.target.checked })} /> Volatility rule (mainnet candles)</label>
      {d.volOn && <div className="mt-2 grid gap-3 sm:grid-cols-4">
        <div><span className="station-code">Frame</span><div className="mt-1"><Segmented<"5m" | "1h"> label="Frame" value={d.frame as "5m" | "1h"} onChange={(f) => setD({ ...d, frame: f })} options={[{ value: "5m", label: "5m" }, { value: "1h", label: "1h" }]} /></div></div>
        <Field label="Candles" value={d.candles} onChange={(e) => setD({ ...d, candles: e.target.value })} inputMode="numeric" />
        <Field label="Threshold" suffix="%" value={d.volPct} onChange={(e) => setD({ ...d, volPct: e.target.value })} inputMode="decimal" />
        <Field label="Withdraw" suffix="%" value={d.volW} onChange={(e) => setD({ ...d, volW: e.target.value })} inputMode="numeric" />
      </div>}
      {err && <p className="mt-2 text-sm text-destructive" role="alert">{err}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn size="sm" variant="line" onClick={save}>Save parameters</Btn>
        {rule.armed ? <Btn size="sm" variant="ghost" onClick={onDisarm}>Disarm</Btn> : <Btn size="sm" disabled={!canArm} onClick={onArm}>Arm at bin {row.activeId}</Btn>}
      </div>
      <p className="mt-2 text-xs text-cream/60">Saving disarms the rule and makes any open review stale. Arming captures the current active bin as the baseline; it is only re-anchored by re-arming or a confirmed rebalance.</p>
    </Panel>
  );
}

function lamportsSol(n: number | null | undefined) { return n === null || n === undefined ? "—" : `${formatUnits(BigInt(n), 9, 9)} SOL`; }

function ReviewPanel({ review, now, stale, running, onApprove, onRebuild, onStage, onClose, row }: { review: Review; now: number; stale: string | null; running: boolean; onApprove: () => void; onRebuild: () => void; onStage: (pool: string) => void; onClose: () => void; row: ViewRow | null }) {
  const head = (t: string, extra?: ReactNode) => <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="display text-2xl">{t}</h2><div className="flex gap-2">{extra}<Btn size="sm" variant="ghost" onClick={onClose}>Close</Btn></div></div>;
  if (review.state === "building") return <Panel tone="cobalt" className="mt-6">{head("Preparing review")}<Spinner label="Fresh chain read, SDK build and exact simulation" /><p className="text-xs text-cream/60">Monitoring is paused while you review.</p></Panel>;
  if (review.state === "error") return <Panel tone="cobalt" className="mt-6">{head("Review unavailable")}<Notice tone="error" title="Couldn't prepare">{review.error}</Notice></Panel>;
  if (review.state === "practice") {
    const p = review.proposal;
    return <Panel tone="cobalt" className="mt-6">{head("Practice review")}<Cap kind="practice" /><p className="mt-2 text-sm">{p.kind === "reduce" ? `Would withdraw ${p.withdrawPct}% of liquidity shares.` : `Would rebalance to bins ${p.target?.lower}–${p.target?.upper} (same width) with the rule's distribution.`} Reason: {p.reason}</p><p className="mt-2 text-sm text-ochre">This is a fictional scenario. There is no transaction, no simulation and nothing to sign.</p></Panel>;
  }
  if (review.state === "staged") {
    return <Panel tone="cobalt" className="mt-6">{head("Native rebalance not available")}<p className="text-sm">{review.reason}</p><p className="mt-2 text-sm text-cream/80">Honest alternative: a staged, non-atomic move — withdraw 100% (position stays open) with one approval, then open a fresh add-liquidity review on the same pool. Price can move between the two.</p><Btn size="sm" className="mt-3" onClick={() => onStage(review.proposal.pool)}>Prepare staged withdrawal</Btn></Panel>;
  }
  const { frozen, built } = review;
  const left = Math.max(0, Math.ceil((frozen.builtAt + REVIEW_TTL_MS - now) / 1000));
  const c = built.b.costs;
  const needs = c.solOutLamports !== null && c.feeLamports !== null ? c.solOutLamports + (c.perTxFee[0] ?? 0) : null;
  const short = needs !== null && c.walletLamports !== null && c.walletLamports < needs;
  const simErr = c.simErrors[0];
  const block = stale ?? (simErr ? `Simulation failed: ${simErr}` : null) ?? (needs === null ? "Costs unknown — cannot sign." : null) ?? (short ? "Wallet SOL is below the simulated requirement." : null);
  const dec = row ? { x: row.decX, y: row.decY } : null;
  return (
    <Panel tone="cobalt" className="mt-6">
      {head(built.kind === "rebalance" ? "Rebalance review" : built.staged ? "Staged move · stage 1 review" : "Withdrawal review", <span className={cn("station-code border px-2 py-1", left > 5 ? "border-cream/60" : "border-destructive text-destructive")} aria-live="polite">{stale ? "stale" : `expires in ${left}s`}</span>)}
      <p className="mt-1 text-sm text-cream/80">{review.proposal.reason}</p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Stat label="Frozen identity" value={`${shortAddr(frozen.wallet)} · ${frozen.cluster === "devnet" ? "devnet" : "mainnet"} · ${frozen.rpcId}`} sub={`rule rev ${frozen.ruleRevision} · slippage ${frozen.slippageBps / 100}%`} />
        <Stat label="Position" value={shortAddr(frozen.position)} sub={`pool ${shortAddr(frozen.pool)}`} />
        {built.kind === "rebalance" ? <>
          <Stat label="Target" value={`${built.b.target.lower}–${built.b.target.upper}`} sub={`${built.b.width} bins, same width · active ${built.b.activeId} · max active-bin slip ${built.b.maxActiveBinSlippage}`} />
          <Stat label="Form" value={built.b.kind === "atomic" ? "One atomic transaction" : "Split: price-level accounts first"} sub={built.b.kind === "split" ? "Only step 1 is sent now; rebuild a fresh review for the rebalance." : "Withdraw + redeposit together"} />
          <Stat label="Withdrawn (SDK sim)" value={dec ? `${formatUnits(built.b.withdrawn.x, dec.x, 6)} X · ${formatUnits(built.b.withdrawn.y, dec.y, 6)} Y` : "—"} />
          <Stat label="Redeposited (SDK sim)" value={dec ? `${formatUnits(built.b.deposited.x, dec.x, 6)} X · ${formatUnits(built.b.deposited.y, dec.y, 6)} Y` : "—"} sub="Zero wallet top-up. Accrued fees are included; rewards are claimed to your wallet." />
          <Stat label="New price-level accounts" value={`${built.b.binArrayCount}`} sub={`rent ${lamportsSol(built.b.binArrayCost * 1e9)} · bitmap ${lamportsSol(built.b.bitmapExtensionCost * 1e9)} (included in simulated SOL)`} />
        </> : <>
          <Stat label="Withdraw" value={`${built.b.bps / 100}% of liquidity shares`} sub={`bins ${built.b.lower}–${built.b.upper}; position stays open, nothing is closed`} />
          <Stat label="Estimated out" value={dec ? `${formatUnits(built.b.estX, dec.x, 6)} X · ${formatUnits(built.b.estY, dec.y, 6)} Y` : "—"} sub="Estimate only — shares are removed; no X/Y output floor is enforced." />
        </>}
        <Stat label="Network fee (tx 1)" value={lamportsSol(c.perTxFee[0])} sub="getFeeForMessage; runner refuses to sign above this" />
        <Stat label="Simulated SOL out" value={lamportsSol(c.solOutLamports)} sub="Wallet balance change in exact simulation (rent, wraps, ATAs). Fee shown separately; may overlap." />
        <Stat label="Wallet SOL" value={lamportsSol(c.walletLamports)} sub={short ? "Insufficient" : undefined} />
        <Stat label="Size / compute" value={`${Number.isFinite(c.sizes[0]) ? c.sizes[0] : "—"} bytes · ${c.units[0] ?? "—"} CU`} sub={c.remaining ? `${c.remaining} later step(s) need a fresh review` : undefined} />
      </dl>
      {block && <Notice tone={stale ? "warn" : "error"} title="Cannot sign this review">{block}</Notice>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn disabled={!!block || running} onClick={onApprove}>{running ? "Waiting for wallet…" : "Approve in wallet"}</Btn>
        <Btn variant="line" disabled={running} onClick={onRebuild}>Refresh &amp; rebuild</Btn>
      </div>
      {c.logs[0]?.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer">Simulation logs</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono">{c.logs[0].slice(-30).join("\n")}</pre></details> : null}
    </Panel>
  );
}

function Capital({ row, cluster, practice, onStage, disabled }: { row: ViewRow; cluster: string; practice: boolean; onStage: (pool: string) => void; disabled: boolean }) {
  const alloc = allocation(row.bins, row.activeId);
  const q = useQuery<PairScan>({ queryKey: ["agents-pair", row.mintX, row.mintY], enabled: !practice && cluster === "mainnet-beta", staleTime: 60_000, retry: false, queryFn: ({ signal }) => discoverSamePair(row.mintX, row.mintY, signal) });
  const f = (v: bigint | undefined, d: number) => (v === undefined ? "—" : formatUnits(v, d, 6));
  const cur = q.data?.rows.find((r) => r.pool.address === row.pair);
  const curFt = cur ? feeTvlPct(cur.pool) : undefined;
  return (
    <section className="mt-8" aria-labelledby="cap-h">
      <h2 id="cap-h" className="display mb-3 text-2xl">Capital check · {shortAddr(row.key)}</h2>
      <Panel>
        {!alloc ? <p className="text-sm text-amber">Per-bin holdings are unavailable for this position.</p> : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="In active bin" value={`${f(alloc.activeX, row.decX)} X`} sub={`${f(alloc.activeY, row.decY)} Y`} />
            <Stat label="In other bins of the range" value={`${f(alloc.outsideX, row.decX)} X`} sub={`${f(alloc.outsideY, row.decY)} Y — intentional range coverage, not waste`} />
            <Stat label="Bins holding liquidity" value={`${alloc.binsWithLiquidity} / ${alloc.binsTotal}`} sub={row.activeId < row.lower || row.activeId > row.upper ? "Active bin is outside the position — none of it is earning swap fees now" : "Active bin is inside the position"} />
          </div>
        )}
      </Panel>
      <h3 className="mt-6 station-code">Same mint pair · other pools (observations, not yield estimates)</h3>
      {practice ? <p className="mt-2 text-sm text-cream/70">The practice scenario has no pool comparison — there is no fictional market data here.</p>
        : cluster !== "mainnet-beta" ? <p className="mt-2 text-sm text-cream/70">Pool comparison uses Meteora's mainnet index and is unavailable on devnet.</p>
        : q.isPending ? <Spinner label="Finding pools with the exact same mints" />
        : q.isError ? <Notice tone="error" title="Comparison unavailable" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{redactUrls(String((q.error as Error)?.message ?? ""))}</Notice>
        : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead><tr className="station-code text-left text-cream/60"><th className="p-2">Pool</th><th className="p-2">Orientation</th><th className="p-2">TVL</th><th className="p-2">Vol 24h</th><th className="p-2">Fees/TVL 24h</th><th className="p-2">Base · dynamic</th><th className="p-2">Bin step</th><th className="p-2" /></tr></thead>
              <tbody>
                {q.data.rows.map(({ pool: p, orientation }) => {
                  const ft = feeTvlPct(p);
                  const listed = curFt !== undefined && ft !== undefined && ft > curFt && p.address !== row.pair;
                  return (
                    <tr key={p.address} className={cn("border-t border-line", p.address === row.pair && "bg-cobalt")}>
                      <td className="p-2"><Link to="/app/pool/$address" params={{ address: p.address }} className="hover:text-amber">{p.name ?? shortAddr(p.address)}</Link>{p.address === row.pair && <span className="ml-2 station-code text-amber">current</span>}</td>
                      <td className="p-2">{orientation === "same" ? "X/Y" : "reversed Y/X"}</td>
                      <td className="p-2">{fmtUsd(p.tvl)}</td><td className="p-2">{fmtUsd(v24(p.volume))}</td><td className="p-2">{fmtPct(ft)}</td>
                      <td className="p-2">{fmtPct(p.pool_config?.base_fee_pct)} · {fmtPct(p.dynamic_fee_pct)}</td><td className="p-2">{p.pool_config?.bin_step ?? "—"}</td>
                      <td className="p-2">{listed && <Btn size="sm" variant="line" disabled={disabled} onClick={() => onStage(p.address)}>Review staged move</Btn>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-cream/60">{q.data.universe}. {q.data.rejected} row(s) excluded. Read {timeAgo(q.data.fetchedAt)}. Shortlisted pools showed higher 24h fees/TVL than the current pool — a past observation, not a forecast. A move is two separate approvals (withdraw, then a fresh add); there is no atomic guarantee and no automatic top-up.</p>
          </div>
        )}
    </section>
  );
}

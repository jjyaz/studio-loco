import { z } from "zod";
import { recordFact } from "@/lib/recorder-store";
import { newId } from "@/lib/recorder";
import { loadSignalHandoff, type ArbHandoff } from "@/lib/signal-handoff";
import { HandoffNotice, useSignalHandoff } from "@/components/signal/handoff";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import BN from "bn.js";
import { Btn, Field, Notice, PageHead, Panel, Stat } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { formatUnits } from "@/lib/amount";
import { explorerAccount, explorerTx, fmtPct, redactUrls, shortAddr } from "@/lib/format";
import { useLocalState, useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CONFIG,
  DECIMALS,
  QUOTE_TTL_MS,
  USDC_MINT,
  WSOL_MINT,
  evaluateRoute,
  realizedDeltas,
  splitFee,
  strictInt,
  validateConfig,
  type ArbConfig,
  type Costs,
  type TxMetaLike,
} from "@/lib/arb-math";
import type { BuiltArb, QuotedLeg, RouteResult, ScanResult, WalletAccounts } from "@/lib/arb";
import { browserPendingStore } from "@/lib/tx";
import { JobCancelled, JobControl, JobTimeout } from "@/lib/job-control";

export const Route = createFileRoute("/app/dispatch")({
  head: () => ({
    meta: [
      { title: "Dispatch · SOL/USDC DLMM round-trip agent — Studio Loco" },
      {
        name: "description",
        content:
          "Scan real Meteora DLMM SOL/USDC pools for two-pool round trips using executable SDK quotes, then review and sign one atomic transaction.",
      },
      { property: "og:title", content: "Dispatch — Studio Loco arbitrage agent" },
      {
        property: "og:description",
        content:
          "Read-only route discovery with real swapQuote results; one atomic, simulated, wallet-approved transaction per route.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) =>
    z.object({ alert: z.string().uuid().optional() }).catch({}).parse(s),
  component: DispatchRoute,
});
function DispatchRoute() {
  return <Dispatch alertId={Route.useSearch().alert} />;
}

function useAlertSearch(): string | undefined {
  const [v, setV] = useState<string | undefined>();
  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get("alert");
    if (a && z.string().uuid().safeParse(a).success) setV(a);
  }, []);
  return v;
}
const SOL = (v: BN | null | undefined) => (v ? `${formatUnits(v, 9)} SOL` : "—");
const FEE = (v: BN, mint: string) =>
  `${formatUnits(v, DECIMALS[mint] ?? 0)} ${mint === WSOL_MINT ? "SOL" : mint === USDC_MINT ? "USDC" : "?"}`;
const ARB_LABEL = "Round trip";
type Draft = Record<
  | "inputSol"
  | "minProfitSol"
  | "priorityFeeSol"
  | "slippageBps"
  | "computeUnits"
  | "intervalSec"
  | "maxPools",
  string
>;
const toDraft = (c: ArbConfig): Draft => ({
  inputSol: c.inputSol,
  minProfitSol: c.minProfitSol,
  priorityFeeSol: c.priorityFeeSol,
  slippageBps: String(c.slippageBps),
  computeUnits: String(c.computeUnits),
  intervalSec: String(c.intervalSec),
  maxPools: String(c.maxPools),
});
const fromDraft = (d: Draft) => ({
  v: 1,
  inputSol: d.inputSol,
  minProfitSol: d.minProfitSol,
  priorityFeeSol: d.priorityFeeSol,
  slippageBps: strictInt(d.slippageBps),
  computeUnits: strictInt(d.computeUnits),
  intervalSec: strictInt(d.intervalSec),
  maxPools: strictInt(d.maxPools),
});
const USDC = (v: BN | null | undefined) => (v ? `${formatUnits(v, 6)} USDC` : "—");
type Log = { at: number; tone: "info" | "warn" | "error" | "ok"; text: string };

interface Review {
  at: number;
  key: string;
  route: RouteResult;
  a: QuotedLeg;
  b: QuotedLeg;
  w: WalletAccounts;
  costs: Costs;
  floor: BN;
  conservativeProfit: BN;
  expectedProfit: BN;
  residualUsdc: BN;
  built: BuiltArb;
  gen: number;
  quotedAt: number;
  wallet: string;
}

export function Dispatch({ alertId }: { alertId?: string } = {}) {
  const fallbackAlert = useAlertSearch();
  const handoff = alertId ?? fallbackAlert;
  const privateSignal = useSignalHandoff(handoff, "arb");
  const [appliedHandoff, setAppliedHandoff] = useState<ArbHandoff | null>(null);
  const reviewRecord = useRef<string | null>(null);
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const [cfg, setCfg] = useLocalState<ArbConfig>("studio-loco:dispatch:v1", DEFAULT_CONFIG, (r) => {
    const v = validateConfig(r);
    return v.ok ? v.cfg : DEFAULT_CONFIG;
  });
  const [draft, setDraft] = useState<Draft>(() => toDraft(DEFAULT_CONFIG));
  useEffect(() => {
    setDraft(toDraft(cfg));
  }, [cfg]);
  const chk = validateConfig(fromDraft(draft));
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
  const ctl = useRef<JobControl>(null as unknown as JobControl);
  if (!ctl.current) ctl.current = new JobControl();
  const [, bump] = useState(0);
  useEffect(() => ctl.current.subscribe(() => bump((x) => x + 1)), []);
  const jobBusy = ctl.current.busy;
  const draining = ctl.current.draining && !ctl.current.running;
  const failures = useRef(0);

  const mainnet = settings.cluster === "mainnet-beta";
  const blocked = !mainnet
    ? "Dispatch supports mainnet SOL/USDC only. Switch the cluster in Settings."
    : settings.practice
      ? "Practice mode is on — Dispatch never uses practice data. Turn it off to scan real pools."
      : null;
  const envKey = `${publicKey?.toBase58() ?? "-"}|${settings.cluster}|${settings.rpc[settings.cluster] ?? ""}|${settings.practice}|${JSON.stringify(fromDraft(draft))}`;
  const live = useRef({ envKey, practice: settings.practice });
  live.current = { envKey, practice: settings.practice };
  const push = (tone: Log["tone"], text: string) =>
    setLog((l) => [{ at: Date.now(), tone, text: redactUrls(text) }, ...l].slice(0, 200));
  /** Cancel every scan/requote job, invalidate reviews and stop monitoring. */
  const cancelAll = (why: string | null) => {
    ctl.current.invalidate();
    setReview(null);
    setReviewing(false);
    setScanning(false);
    setMonitor((m) => {
      if (m && why) push("warn", why);
      return false;
    });
  };
  async function applyHandoff() {
    if (blocked || runner.running || ctl.current.busy) return;
    const h = await privateSignal.reload();
    if (!h || h.kind !== "arb") return;
    cancelAll(null);
    setScan(null);
    setScanErr(null);
    setRevErr(null);
    setRealized(null);
    setCfg(h.config);
    setDraft(toDraft(h.config));
    setAppliedHandoff(h);
    void recordFact({
      kind: "alert-handoff",
      title: "Signal Box → Dispatch",
      route: "/app/dispatch",
      cluster: "mainnet-beta",
      links: { alertId: h.alertId, watchId: h.watchId },
      detail:
        "Loaded the private current arbitrage watch configuration. Scan again and make a new wallet-specific requote; the hosted opportunity may have passed.",
      context: {
        watchRevision: h.watchRevision,
        inputSol: h.config.inputSol,
        minProfitSol: h.config.minProfitSol,
        observedAt: h.observedAt,
      },
    });
  }
  const cloudLinks = appliedHandoff
    ? { alertId: appliedHandoff.alertId, watchId: appliedHandoff.watchId }
    : {};
  useEffect(() => {
    if (!appliedHandoff) return;
    if (
      privateSignal.error ||
      handoff !== appliedHandoff.alertId ||
      blocked ||
      now >= appliedHandoff.expiresAt ||
      JSON.stringify(fromDraft(draft)) !== JSON.stringify(appliedHandoff.config)
    ) {
      setAppliedHandoff(null);
      cancelAll("Hosted alert context changed. Make a fresh review.");
    }
  }, [appliedHandoff, privateSignal.error, handoff, blocked, now, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // any identity/settings change invalidates review and stops monitoring
  const prevKey = useRef(envKey);
  useEffect(() => {
    if (prevKey.current === envKey) return;
    prevKey.current = envKey;
    cancelAll("Monitoring paused: wallet, network, RPC, practice or configuration changed.");
    setScan(null);
  }, [envKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    ctl.current.mounted = true;
    return () => ctl.current.unmount();
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const vis = () => {
      if (document.hidden) cancelAll("Monitoring paused: tab hidden.");
    };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const gen = {
    get current() {
      return ctl.current.gen;
    },
  };
  const mounted = {
    get current() {
      return ctl.current.mounted;
    },
  };
  const reportErr = (e: unknown, what: string) => {
    if (e instanceof JobCancelled) return null;
    const m = redactUrls(e instanceof Error ? e.message : String(e));
    push(e instanceof JobTimeout ? "warn" : "error", `${what}: ${m}`);
    return m;
  };

  async function scanOnce(source: "manual" | "monitor") {
    if (blocked || !chk.ok || reviewing || review || runner.running) return;
    const job = ctl.current.begin();
    if (!job) {
      if (source === "manual")
        push(
          "warn",
          ctl.current.draining
            ? "Waiting for a timed-out request to drain."
            : "Another job is running.",
        );
      return;
    }
    setScanning(true);
    setScanErr(null);
    const c = chk.cfg;
    try {
      const { scanRoutes, readOnlyScanCosts } = await job.step(import("@/lib/arb"), 30_000, "Load");
      // Shared with the hosted Signal Box arb watch: identical read-only cost assumptions.
      const costs: Costs = await job.step(
        readOnlyScanCosts(connection, chk.priorityBudget, c.computeUnits),
        35_000,
        "Cost read",
      );
      const r = await job.step(
        scanRoutes(connection, {
          inLamports: chk.inLamports,
          minProfit: chk.minProfit,
          slippageBps: c.slippageBps,
          maxPools: c.maxPools,
          costs,
          signal: job.signal,
          log: (m) => {
            if (job.alive()) push("info", m);
          },
        }),
        180_000,
        "Scan",
      );
      setScan(r);
      failures.current = 0;
      const prof = r.routes.filter((x) => x.verdict.kind === "profitable").length;
      const errs = r.pools.filter((p) => p.status !== "ok" || p.reason).length;
      for (const route of r.routes.filter((x) => x.verdict.kind === "profitable").slice(0, 20)) {
        void recordFact({
          kind: "proposal",
          title: `Dispatch proposal ${route.nameA} → ${route.nameB}`,
          route: "/app/dispatch",
          cluster: "mainnet-beta",
          links: cloudLinks,
          detail:
            "Read-only quote met the configured floor using estimated costs. A fresh wallet-specific review is required.",
          context: {
            poolA: route.a.pool,
            poolB: route.b?.pool ?? null,
            inputSol: c.inputSol,
            minProfitSol: c.minProfitSol,
            completeScan: r.complete,
            expectedProfitLamports:
              route.verdict.kind === "profitable" ? route.verdict.expectedProfit.toString() : null,
          },
        });
      }
      push(
        prof ? "ok" : r.complete ? "info" : "warn",
        `${source === "monitor" ? "Monitor" : "Scan"}: ${r.routes.length} routes quoted, ${prof} meet the net-profit floor${errs ? `, ${errs} pool(s) rejected or errored` : ""}${r.complete ? "" : " — partial evidence"}.`,
      );
    } catch (e) {
      if (!job.alive() && !(e instanceof JobTimeout)) return;
      failures.current++;
      const m = reportErr(e, "Scan failed");
      if (m && job.alive()) setScanErr(m);
    } finally {
      const own = job.alive();
      ctl.current.end(job);
      if (own) setScanning(false);
    }
  }

  // monitoring loop: sequential, no overlap, exponential backoff on failure, proposals only
  useEffect(() => {
    if (!monitor || review || reviewing || runner.running) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      await scanOnce("monitor");
      if (stop) return;
      const back = Math.min(600, cfg.intervalSec * 2 ** Math.min(failures.current, 4));
      t = setTimeout(tick, back * 1000);
    };
    push(
      "info",
      `Monitoring started (every ${cfg.intervalSec}s, this tab only, discovers proposals — never signs).`,
    );
    void tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [monitor, !!review, reviewing, runner.running]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMonitor() {
    if (monitor) {
      cancelAll(null);
      push("info", "Monitoring paused by you; in-flight work cancelled.");
      return;
    }
    if (jobBusy || reviewing || review || runner.running) return;
    push("info", "Monitoring requested.");
    setMonitor(true);
  }

  async function requote(route: RouteResult) {
    if (!publicKey || !chk.ok || blocked || reviewing || runner.running || !route.b) return;
    if (browserPendingStore.list().some((p) => p.label.startsWith(ARB_LABEL))) {
      setRevErr(
        "An earlier round-trip signature is unresolved. Check its status above before starting another.",
      );
      return;
    }
    // Stop monitoring and cancel any scan before taking the lock.
    if (monitor || ctl.current.running) {
      cancelAll(monitor ? "Monitoring paused for review." : null);
    }
    const job = ctl.current.begin();
    if (!job) {
      setRevErr(
        ctl.current.draining
          ? "Waiting for a timed-out request to finish draining — try again shortly."
          : "Another job is running.",
      );
      return;
    }
    setReviewing(true);
    setRevErr(null);
    setReview(null);
    const recordId = newId("rev");
    reviewRecord.current = recordId;
    void recordFact({
      id: recordId,
      kind: "review",
      status: "open",
      title: `Dispatch review ${route.nameA} → ${route.nameB}`,
      route: "/app/dispatch",
      cluster: "mainnet-beta",
      wallet: publicKey.toBase58(),
      links: cloudLinks,
      detail:
        "Preparing a fresh wallet-specific requote. Simulation runs in the shared runner before wallet approval.",
    });
    const key = envKey + "|" + route.a.pool + ">" + route.b.pool;
    const myGen = job.gen;
    const c = chk.cfg;
    const user = publicKey;
    const S = job.step;
    try {
      if (appliedHandoff) {
        const current = await S(
          loadSignalHandoff(appliedHandoff.alertId, "arb"),
          15_000,
          "Current private watch verification",
        );
        if (
          current.watchRevision !== appliedHandoff.watchRevision ||
          current.accountId !== appliedHandoff.accountId
        )
          throw new Error("The hosted watch changed. Load its current rules before reviewing.");
      }
      const arb = await S(import("@/lib/arb"), 30_000, "Load");
      const { getPool, invalidatePool } = await S(import("@/lib/dlmm"), 30_000, "Load SDK");
      const load = async (p: string) => {
        invalidatePool(p);
        const x = await S(getPool(connection, p, "mainnet-beta"), 20_000, "SDK pool load");
        await S(x.refetchStates(), 15_000, "Pool refresh");
        return x;
      };
      const [poolA, poolB] = await Promise.all([load(route.a.pool), load(route.b.pool)]);
      for (const p of [poolA, poolB]) {
        const bad = await S(arb.verifyPool(connection, p), 15_000, "Pool verification");
        if (bad) throw new Error(`${shortAddr(p.pubkey.toBase58())}: ${bad}`);
      }
      const mintErr = await S(arb.verifyMints(connection), 15_000, "Mint verification");
      if (mintErr) throw new Error(mintErr);
      const w = await S(arb.readWalletAccounts(connection, user), 15_000, "Wallet accounts");
      const micro = arb.priorityPrice(chk.priorityBudget, c.computeUnits);
      const quotedAt = Date.now();
      const a = await S(
        arb.quoteLeg(poolA, WSOL_MINT, chk.inLamports, c.slippageBps),
        15_000,
        "Leg A quote",
      );
      if (!a.consumed.eq(a.requested)) throw new Error("Leg A would be a partial fill — rejected");
      const b = await S(
        arb.quoteLeg(poolB, USDC_MINT, a.min, c.slippageBps),
        15_000,
        "Leg B quote",
      );
      if (b.min.isZero()) throw new Error("Leg B minimum is zero");
      // Build with the quote minimum as the on-chain floor, then read the ACTUAL fee for this message.
      const probe = await S(
        arb.buildArbTx({
          user,
          poolA,
          poolB,
          a,
          b,
          floor: b.min,
          w,
          microLamports: micro,
          computeUnits: c.computeUnits,
        }),
        15_000,
        "Build",
      );
      const fee = await S(arb.messageFee(connection, probe.tx), 25_000, "Fee read");
      const costs: Costs = {
        networkFee: fee,
        priorityPart: arb.priorityFeeLamports(micro, c.computeUnits),
        feeSource: "exact",
        nonRefundableRent: w.usdcExists ? new BN(0) : w.ataRent,
        refundableRent: w.wsolExists ? new BN(0) : w.ataRent,
      };
      const v = evaluateRoute(a, b, chk.minProfit, costs);
      if (v.kind !== "profitable")
        throw new Error(
          v.kind === "invalid"
            ? v.reason
            : `No profitable route right now: ${v.reason}. Expected net ${v.expectedProfit ? SOL(v.expectedProfit) : "—"}.`,
        );
      // Balance: input + fees + every rent deposit (refundable WSOL rent is still needed up front)
      const need = chk.inLamports.add(v.costs).add(costs.refundableRent ?? new BN(0));
      if (w.lamports.lt(need))
        throw new Error(`Insufficient SOL: need ${SOL(need)}, wallet has ${SOL(w.lamports)}`);
      // Rebuild with the ENFORCED floor (input + exact fee + kept rent + min profit) and re-read its fee.
      const final = await S(
        arb.buildArbTx({
          user,
          poolA,
          poolB,
          a,
          b,
          floor: v.floor,
          w,
          microLamports: micro,
          computeUnits: c.computeUnits,
        }),
        15_000,
        "Build",
      );
      const fee2 = await S(arb.messageFee(connection, final.tx), 25_000, "Fee read");
      if (!fee2 || !fee || fee2.gt(fee))
        throw new Error(
          "Network fee is unknown or changed for the final message — review blocked.",
        );
      job.check();
      setReview({
        at: quotedAt,
        quotedAt,
        gen: myGen,
        wallet: user.toBase58(),
        key,
        route,
        a,
        b,
        w,
        costs,
        floor: v.floor,
        conservativeProfit: v.conservativeProfit,
        expectedProfit: v.expectedProfit,
        residualUsdc: v.residualUsdc,
        built: final,
      });
      push(
        "info",
        `Review ready: ${route.nameA} → ${route.nameB}, ${final.bytes} bytes, quote valid ${QUOTE_TTL_MS / 1000}s.`,
      );
      void recordFact({
        id: recordId,
        kind: "review",
        title: `Dispatch review ${route.nameA} → ${route.nameB}`,
        route: "/app/dispatch",
        cluster: "mainnet-beta",
        wallet: user.toBase58(),
        links: cloudLinks,
        detail: `Fresh wallet-specific requote; floor ${v.floor.toString()} lamports; quote valid ${QUOTE_TTL_MS / 1000}s; ${final.bytes} bytes; simulation is required before wallet approval.`,
        context: {
          poolA: a.pool,
          poolB: b.pool,
          inputLamports: a.requested.toString(),
          legAMin: a.min.toString(),
          legBMin: b.min.toString(),
          floorLamports: v.floor.toString(),
          expectedProfitLamports: v.expectedProfit.toString(),
          conservativeProfitLamports: v.conservativeProfit.toString(),
          networkFeeLamports: costs.networkFee?.toString() ?? null,
          slippageBps: chk.ok ? chk.cfg.slippageBps : null,
          quotedAt,
        },
      }).catch(() => {});
    } catch (e) {
      void recordFact({
        id: recordId,
        kind: "review",
        status: e instanceof JobCancelled ? "rejected" : "failed",
        title: `Dispatch review ${route.nameA} → ${route.nameB}`,
        route: "/app/dispatch",
        cluster: "mainnet-beta",
        wallet: user.toBase58(),
        links: cloudLinks,
        detail:
          e instanceof JobCancelled
            ? "Preparation cancelled; nothing signed."
            : e instanceof Error
              ? e.message
              : String(e),
      });
      // obsolete jobs never overwrite newer state; a timeout of the CURRENT job is reported
      if (!job.alive()) return;
      const m = reportErr(e, "Requote");
      if (m) setRevErr(m);
    } finally {
      const own = job.alive();
      ctl.current.end(job);
      if (own) setReviewing(false);
    }
  }

  const expired = review ? now - review.at > QUOTE_TTL_MS : false;
  const stale = review ? !review.key.startsWith(envKey + "|") : false;

  async function approve() {
    if (
      !review ||
      stale ||
      runner.running ||
      !publicKey ||
      Date.now() - review.quotedAt > QUOTE_TTL_MS
    )
      return;
    if (browserPendingStore.list().some((p) => p.label.startsWith(ARB_LABEL))) {
      setRevErr("An earlier round-trip signature is unresolved — check it first.");
      return;
    }
    const r = review;
    setReview(null); // single use: never re-sent
    push("info", "Sending to wallet for approval (one atomic transaction)…");
    try {
      const semanticGuard = () => {
        if (!mounted.current) return "Page closed — transaction discarded.";
        if (gen.current !== r.gen)
          return "Inputs, network or practice mode changed — transaction discarded.";
        if (live.current.practice) return "Practice mode is on — transaction discarded.";
        if (!r.key.startsWith(live.current.envKey + "|"))
          return "Configuration changed — transaction discarded.";
        if (Date.now() - r.quotedAt > QUOTE_TTL_MS)
          return "Quote expired — transaction discarded. Requote to try again.";
        return null;
      };
      const steps = await runner.run(
        [{ label: `${ARB_LABEL} ${r.route.nameA} → ${r.route.nameB}`, tx: r.built.tx }],
        {
          semanticGuard,
          maxFeeLamports: Number(r.costs.networkFee!.toString()),
          evidence: {
            title: `Dispatch round trip ${r.route.nameA} → ${r.route.nameB}`,
            links: {
              ...(reviewRecord.current
                ? { recordId: reviewRecord.current, reviewId: reviewRecord.current }
                : {}),
              ...cloudLinks,
            },
            context: {
              floorLamports: r.floor.toString(),
              networkFeeCapLamports: r.costs.networkFee!.toString(),
              poolA: r.a.pool,
              poolB: r.b.pool,
            },
          },
        },
      );
      const s = steps[0];
      push(
        s?.phase === "confirmed" ? "ok" : "warn",
        `Transaction ${s?.phase ?? "not run"}${s?.signature ? ` · ${shortAddr(s.signature, 6)}` : ""}${s?.error ? `: ${s.error}` : ""}`,
      );
      if (s?.phase === "confirmed" && s.signature) {
        try {
          const { withTimeout } = await import("@/lib/tx");
          const tx = await withTimeout(
            connection.getTransaction(s.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            }),
            15_000,
            "Receipt read",
          );
          if (!tx?.meta) {
            setRealized({
              sig: s.signature,
              text: [
                "Confirmed, but transaction metadata is not available from this RPC yet — realized deltas unknown.",
              ],
            });
            return;
          }
          const d = realizedDeltas(tx.meta as unknown as TxMetaLike, publicKey.toBase58());
          setRealized({
            sig: s.signature,
            text: [
              `Network fee charged: ${SOL(d.fee)}`,
              `Native SOL change (incl. fee, rent): ${SOL(d.lamports)}`,
              `WSOL token change: ${SOL(d.wsol)}`,
              `USDC change (residual dust): ${USDC(d.usdc)}`,
              `Realized net SOL (native + WSOL): ${d.netSol ? SOL(d.netSol) : "UNKNOWN"}`,
              ...(d.failed ? ["Metadata reports the transaction FAILED."] : []),
            ],
          });
        } catch (e) {
          setRealized({
            sig: s.signature,
            text: [
              `Confirmed; metadata read failed: ${redactUrls(e instanceof Error ? e.message : String(e))}`,
            ],
          });
        }
      }
    } catch (e) {
      push("error", redactUrls(e instanceof Error ? e.message : String(e)));
    }
  }

  function exportCfg() {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "studio-loco-dispatch.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function importCfg() {
    try {
      const v = validateConfig(JSON.parse(importText));
      if (!v.ok) throw new Error(v.error);
      setCfg(v.cfg);
      setImportText("");
      push("ok", "Configuration imported.");
    } catch (e) {
      push("error", `Import rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const set = (k: keyof Draft, v: string) => {
    const d = { ...draft, [k]: v };
    setDraft(d);
    const r = validateConfig(fromDraft(d));
    if (r.ok) setCfg(r.cfg);
  };

  const routes = scan?.routes ?? [];
  const best = routes.find((r) => r.verdict.kind === "profitable") ?? null;

  return (
    <div>
      <PageHead
        code="ST-06 · Dispatch"
        title="Two pools, one train."
        intro="Finds SOL → USDC → SOL round trips across two Meteora DLMM pools using real SDK quotes. Scanning is read-only. A route executes only as one atomic transaction that you review, simulate and approve."
        cap={["live"]}
      />
      <HandoffNotice
        id={handoff}
        state={privateSignal}
        applied={!!appliedHandoff}
        blocked={
          blocked ??
          (runner.running || ctl.current.busy ? "Wait for the current action to finish." : null)
        }
        onApply={() => void applyHandoff()}
      />
      <p className="-mt-2 mb-6 text-sm text-cream/75">
        Want armed rules with reviewable rebalance and withdrawal proposals? Open{" "}
        <Link to="/app/agents" className="underline hover:text-amber">
          Liquidity Agents
        </Link>
        .
      </p>
      {blocked && (
        <div className="mb-6">
          <Notice tone="warn" title="Dispatch unavailable">
            {blocked}
          </Notice>
        </div>
      )}
      <div className="mb-6">
        <Notice tone="info" title="Read before using">
          Estimates are not guarantees. A transaction that fails onchain still pays its network and
          priority fees. Monitoring runs only in this open tab, finds proposals and never signs.
          Ordinary DLMM program only — DLMM Pro is not integrated.
        </Notice>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div className="flex flex-col gap-6">
          <Panel>
            <h2 className="display text-2xl">Route config</h2>
            <dl className="mt-3 text-xs">
              <dt className="station-code text-cream/65">WSOL mint</dt>
              <dd className="break-all font-mono">
                <a
                  className="underline"
                  href={explorerAccount(WSOL_MINT, "mainnet-beta")}
                  target="_blank"
                  rel="noreferrer"
                >
                  {WSOL_MINT}
                </a>
              </dd>
              <dt className="station-code mt-2 text-cream/65">USDC mint</dt>
              <dd className="break-all font-mono">
                <a
                  className="underline"
                  href={explorerAccount(USDC_MINT, "mainnet-beta")}
                  target="_blank"
                  rel="noreferrer"
                >
                  {USDC_MINT}
                </a>
              </dd>
            </dl>
            <div className="mt-4 flex flex-col gap-3">
              <Field
                label="Input"
                suffix="SOL"
                inputMode="decimal"
                value={draft.inputSol}
                onChange={(e) => set("inputSol", e.target.value)}
              />
              <Field
                label="Minimum net profit"
                suffix="SOL"
                inputMode="decimal"
                value={draft.minProfitSol}
                onChange={(e) => set("minProfitSol", e.target.value)}
              />
              <Field
                label="Slippage per leg"
                suffix="bps"
                inputMode="numeric"
                value={draft.slippageBps}
                onChange={(e) => set("slippageBps", e.target.value)}
                hint="1–300 bps. Applied to each leg's minimum output."
              />
              <Field
                label="Priority-fee budget"
                suffix="SOL"
                inputMode="decimal"
                value={draft.priorityFeeSol}
                onChange={(e) => set("priorityFeeSol", e.target.value)}
              />
              <Field
                label="Compute-unit limit"
                inputMode="numeric"
                value={draft.computeUnits}
                onChange={(e) => set("computeUnits", e.target.value)}
              />
              <Field
                label="Monitor interval"
                suffix="s"
                inputMode="numeric"
                value={draft.intervalSec}
                onChange={(e) => set("intervalSec", e.target.value)}
                hint="30–600 s (default 60); backs off after errors."
              />
              <Field
                label="Pools to compare"
                inputMode="numeric"
                value={draft.maxPools}
                onChange={(e) => set("maxPools", e.target.value)}
                hint="2–5 highest-TVL exact SOL/USDC pools."
              />
              {!chk.ok && (
                <p role="alert" className="text-sm text-destructive">
                  {chk.error}
                </p>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn size="sm" variant="line" onClick={exportCfg}>
                Export JSON
              </Btn>
              <Btn
                size="sm"
                variant="quiet"
                onClick={() => {
                  setCfg(DEFAULT_CONFIG);
                  setDraft(toDraft(DEFAULT_CONFIG));
                }}
              >
                Reset
              </Btn>
            </div>
            <label className="mt-3 block text-sm">
              <span className="station-code text-cream/70">Import config (v1 JSON)</span>
              <textarea
                className="mt-1 h-20 w-full border border-line bg-midnight p-2 font-mono text-xs"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </label>
            <Btn
              size="sm"
              variant="line"
              className="mt-2"
              onClick={importCfg}
              disabled={!importText.trim()}
            >
              Import
            </Btn>
          </Panel>
        </div>

        <div className="flex flex-col gap-6">
          <Panel tone="cobalt">
            <div className="flex flex-wrap items-center gap-3">
              <Btn
                onClick={() => scanOnce("manual")}
                disabled={
                  jobBusy ||
                  scanning ||
                  reviewing ||
                  !!review ||
                  runner.running ||
                  !!blocked ||
                  !chk.ok
                }
              >
                {draining ? "Draining…" : scanning ? "Scanning…" : "Scan once"}
              </Btn>
              <Btn
                variant="line"
                onClick={toggleMonitor}
                disabled={
                  !monitor &&
                  (jobBusy || reviewing || !!review || runner.running || !!blocked || !chk.ok)
                }
                aria-pressed={monitor}
              >
                {monitor ? "Pause monitoring" : "Start monitoring"}
              </Btn>
              <span className="station-code text-cream/75" role="status">
                {monitor ? "● Monitoring this tab" : "Monitoring off"}
                {scan ? ` · last scan ${Math.round((now - scan.at) / 1000)}s ago` : ""}
              </span>
            </div>
            {scanErr && (
              <div className="mt-4">
                <Notice tone="error" title="Scan failed">
                  {scanErr}
                </Notice>
              </div>
            )}
            {scan && now - scan.at > 60_000 && (
              <p className="mt-3 text-sm text-amber">
                These results are stale (over 60s old). Scan again before acting.
              </p>
            )}
            {scan && (
              <div className="mt-5">
                <h3 className="station-code text-amber">Pools · on-chain verified</h3>
                <ul className="mt-2 grid gap-1 text-sm">
                  {scan.pools.map((p) => (
                    <li key={p.address} className="flex flex-wrap gap-2">
                      <span
                        className={cn(
                          "station-code",
                          p.status === "ok" && !p.reason ? "text-success" : "text-destructive",
                        )}
                      >
                        {p.status === "ok" && !p.reason ? "OK" : p.status.toUpperCase()}
                      </span>
                      <span>{p.name}</span>
                      <a
                        className="font-mono text-xs underline"
                        href={explorerAccount(p.address, "mainnet-beta")}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddr(p.address, 5)}
                      </a>
                      {p.reason && <span className="text-xs text-cream/70">{p.reason}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          {scan && (
            <Panel>
              <h2 className="display text-2xl">Routes</h2>
              {!best && scan.complete && (
                <p className="mt-2 text-sm text-cream/80" role="status">
                  No profitable route: none of the {routes.length} quoted round trips cover input +
                  estimated fee + assumed new-account rent + your minimum net profit. That is the
                  normal result.
                </p>
              )}
              {!best && !scan.complete && (
                <p className="mt-2 text-sm text-amber" role="status">
                  Insufficient evidence: some pools or quotes failed, so this scan cannot say
                  whether a profitable route exists.
                </p>
              )}
              {scan.discoveryRejected.length > 0 && (
                <p className="mt-2 text-xs text-cream/70">
                  Discovery rejected: {scan.discoveryRejected.join("; ")}
                </p>
              )}
              <p className="mt-2 text-xs text-cream/65">
                Scan fee is an RPC estimate ({SOL(scan.costs.networkFee)}); the review reads the
                exact fee for your transaction.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <caption className="sr-only">Quoted round-trip routes</caption>
                  <thead className="station-code text-cream/65">
                    <tr>
                      <th className="py-2">Leg A → Leg B</th>
                      <th>USDC (A min)</th>
                      <th>SOL out (exp / min)</th>
                      <th>Expected net</th>
                      <th>Verdict</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="py-2">
                          {r.nameA}
                          <br />→ {r.nameB}
                        </td>
                        <td className="font-mono">{formatUnits(r.a.min, 6)}</td>
                        <td className="font-mono">
                          {r.b ? `${formatUnits(r.b.out, 9)} / ${formatUnits(r.b.min, 9)}` : "—"}
                        </td>
                        <td className="font-mono">
                          {r.verdict.kind === "profitable"
                            ? SOL(r.verdict.expectedProfit)
                            : r.verdict.kind === "unprofitable"
                              ? SOL(r.verdict.expectedProfit)
                              : "—"}
                        </td>
                        <td
                          className={cn(
                            "text-xs",
                            r.verdict.kind === "profitable"
                              ? "text-success"
                              : r.verdict.kind === "invalid"
                                ? "text-destructive"
                                : "text-cream/75",
                          )}
                        >
                          {r.verdict.kind === "profitable" ? "Meets floor" : r.verdict.reason}
                        </td>
                        <td>
                          {r.b &&
                            r.verdict.kind !== "invalid" &&
                            (publicKey ? (
                              <Btn
                                size="sm"
                                onClick={() => requote(r)}
                                disabled={reviewing || runner.running || draining}
                              >
                                {reviewing ? "Requoting…" : "Requote & Review"}
                              </Btn>
                            ) : (
                              <span className="text-xs text-cream/70">
                                Connect wallet to review
                              </span>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!publicKey && (
                <div className="mt-4 flex items-center gap-3 text-sm text-cream/75">
                  <WalletButton /> Scanning works without a wallet.
                </div>
              )}
            </Panel>
          )}

          {revErr && (
            <Notice tone="warn" title="Review unavailable">
              {revErr}
            </Notice>
          )}
          {review && (
            <Panel tone="cobalt">
              <h2 className="display text-2xl">Review · one atomic transaction</h2>
              <p
                className={cn(
                  "station-code mt-1",
                  expired || stale ? "text-destructive" : "text-amber",
                )}
              >
                {stale
                  ? "Inputs changed — requote"
                  : expired
                    ? "Quote expired — requote"
                    : `${Math.ceil((QUOTE_TTL_MS - (now - review.at)) / 1000)}s left`}
              </p>
              <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                <dt className="text-cream/70">Leg A pool</dt>
                <dd className="font-mono">
                  {review.route.nameA} · {shortAddr(review.a.pool, 5)}
                </dd>
                <dt className="text-cream/70">Input consumed</dt>
                <dd className="font-mono">{SOL(review.a.consumed)}</dd>
                <dt className="text-cream/70">Leg A expected / min</dt>
                <dd className="font-mono">
                  {USDC(review.a.out)} / {USDC(review.a.min)}
                </dd>
                <dt className="text-cream/70">Leg A DLMM fee (in quote)</dt>
                <dd className="font-mono">
                  {FEE(review.a.fee, review.a.feeMint)} (protocol share{" "}
                  {FEE(review.a.protocolFee, review.a.feeMint)}) · impact{" "}
                  {fmtPct(Number(review.a.impactPct))}
                </dd>
                <dt className="text-cream/70">Leg B pool</dt>
                <dd className="font-mono">
                  {review.route.nameB} · {shortAddr(review.b.pool, 5)}
                </dd>
                <dt className="text-cream/70">Leg B input (= A min)</dt>
                <dd className="font-mono">{USDC(review.b.consumed)}</dd>
                <dt className="text-cream/70">Leg B expected / quote min</dt>
                <dd className="font-mono">
                  {SOL(review.b.out)} / {SOL(review.b.min)}
                </dd>
                <dt className="text-cream/70">Leg B DLMM fee (in quote)</dt>
                <dd className="font-mono">
                  {FEE(review.b.fee, review.b.feeMint)} (protocol share{" "}
                  {FEE(review.b.protocolFee, review.b.feeMint)}) · impact{" "}
                  {fmtPct(Number(review.b.impactPct))}
                </dd>
                <dt className="text-cream/70">Enforced SOL floor</dt>
                <dd className="font-mono text-amber">{SOL(BN.max(review.floor, review.b.min))}</dd>
                <dt className="text-cream/70">Network fee (exact, incl. priority)</dt>
                <dd className="font-mono">{SOL(review.costs.networkFee)}</dd>
                <dt className="text-cream/70">· of which base / priority</dt>
                <dd className="font-mono">
                  {(() => {
                    const f = splitFee(
                      review.costs.networkFee,
                      review.costs.priorityPart ?? new BN(0),
                    );
                    return `${SOL(f.base)} / ${SOL(f.priority)}`;
                  })()}
                </dd>
                <dt className="text-cream/70">New USDC account rent (kept)</dt>
                <dd className="font-mono">{SOL(review.costs.nonRefundableRent)}</dd>
                <dt className="text-cream/70">Temporary WSOL rent (returned)</dt>
                <dd className="font-mono">{SOL(review.costs.refundableRent)}</dd>
                <dt className="text-cream/70">Residual USDC dust (expected)</dt>
                <dd className="font-mono">{USDC(review.residualUsdc)}</dd>
                <dt className="text-cream/70">Expected net SOL</dt>
                <dd className="font-mono">{SOL(review.expectedProfit)}</dd>
                <dt className="text-cream/70">Conservative net SOL</dt>
                <dd className="font-mono text-success">{SOL(review.conservativeProfit)}</dd>
                <dt className="text-cream/70">Size / programs</dt>
                <dd className="font-mono text-xs">
                  {review.built.bytes} B · {review.built.programs.length} programs
                </dd>
              </dl>
              <p className="mt-3 text-xs text-cream/75">
                WSOL account:{" "}
                {review.w.wsolExists
                  ? "existing — not closed; output SOL stays wrapped there"
                  : "created and closed in this transaction"}
                . USDC account:{" "}
                {review.w.usdcExists
                  ? "existing — never closed or drained"
                  : "created and kept (holds residual dust)"}
                . The exact message is simulated before your wallet opens; if simulation fails
                nothing is requested.
              </p>
              <Btn
                className="mt-4 w-full"
                onClick={approve}
                disabled={expired || stale || runner.running}
              >
                {runner.running ? "Working…" : "Simulate & approve in wallet"}
              </Btn>
            </Panel>
          )}
          <TxSteps steps={runner.steps} />
          {realized && (
            <Panel>
              <h3 className="station-code text-amber">Realized · from chain metadata</h3>
              <ul className="mt-2 text-sm">
                {realized.text.map((t) => (
                  <li key={t} className="font-mono">
                    {t}
                  </li>
                ))}
              </ul>
              <a
                className="station-code mt-2 inline-block text-amber underline"
                href={explorerTx(realized.sig, "mainnet-beta")}
                target="_blank"
                rel="noreferrer"
              >
                View on explorer ↗
              </a>
            </Panel>
          )}

          <Panel>
            <div className="flex items-center justify-between">
              <h3 className="station-code text-amber">Activity journal</h3>
              <Btn size="sm" variant="quiet" onClick={() => setLog([])}>
                Clear
              </Btn>
            </div>
            {log.length === 0 ? (
              <p className="mt-2 text-sm text-cream/70">Nothing yet. Run a scan.</p>
            ) : (
              <ol className="mt-2 max-h-72 overflow-auto text-xs" aria-live="polite">
                {log.map((l, i) => (
                  <li
                    key={i}
                    className={cn(
                      "border-t border-line py-1",
                      l.tone === "error" && "text-destructive",
                      l.tone === "warn" && "text-amber",
                      l.tone === "ok" && "text-success",
                    )}
                  >
                    <span className="font-mono text-cream/55">
                      {new Date(l.at).toLocaleTimeString()}
                    </span>{" "}
                    {l.text}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Connection } from "@solana/web3.js";
import { Btn, Field, Notice, Panel, Spinner } from "@/components/kit";
import { formatUnits } from "@/lib/amount";
import { redactUrls, shortAddr } from "@/lib/format";
import { JobCancelled, JobControl } from "@/lib/job-control";
import { newId } from "@/lib/recorder";
import { recordFact } from "@/lib/recorder-store";
import { distribute } from "@/lib/strategy";
import { discoverSamePair, type PairScan } from "@/lib/agents-chain";
import { readPlan } from "@/lib/planner-chain";
import {
  OPTION_LABEL, PLAN_SNAPSHOT_TTL_MS, comparisonFact, feeRecovery, planIdentityKey, selectionFact, selectionRefusal,
  solTextToLamports, validateWiden, widthOf, type PlanIdentity, type PlanOption, type PlanSnapshot, type Range,
} from "@/lib/planner";

export interface PlannerRow { key: string; pair: string; lower: number; upper: number; activeId: number; mintX: string; mintY: string; decX: number; decY: number }
type BaseIdentity = Omit<PlanIdentity, "widenLower" | "widenUpper" | "destPool">;

export function RebalancePlanner({ row, base, connection, actionBlock, onReview, onIdentityChange }: {
  row: PlannerRow;
  base: BaseIdentity;
  connection: Connection;
  /** Non-null when wallet actions are off (watch-only, settlement pending, etc.). */
  actionBlock: string | null;
  onReview: (s: PlanSnapshot, option: PlanOption, selectionRecordId: string) => void;
  onIdentityChange?: (key: string) => void;
}) {
  const [lo, setLo] = useState(String(row.lower - 5));
  const [hi, setHi] = useState(String(row.upper + 5));
  const [dest, setDest] = useState("");
  const [assume, setAssume] = useState("");
  const [snap, setSnap] = useState<{ s: PlanSnapshot; recordId: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastSel, setLastSel] = useState<{ option: PlanOption; recordId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ctl = useRef<JobControl | null>(null);
  if (!ctl.current) ctl.current = new JobControl();
  const [, force] = useState(0);
  useEffect(() => ctl.current!.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => () => ctl.current!.unmount(), []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const widen = validateWiden(row, lo.trim() === "" ? null : Number(lo), hi.trim() === "" ? null : Number(hi));
  const identity: PlanIdentity = { ...base, widenLower: widen.ok ? widen.range.lower : null, widenUpper: widen.ok ? widen.range.upper : null, destPool: dest || null };
  const liveKey = planIdentityKey(identity);
  // Any identity change cancels in-flight planning and drops the old comparison.
  useEffect(() => { ctl.current!.invalidate(); setSnap((p) => (p && p.s.identityKey !== liveKey ? null : p)); setLastSel(null); onIdentityChange?.(liveKey); }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairs = useQuery<PairScan>({
    queryKey: ["planner-pair", row.mintX, row.mintY],
    enabled: base.cluster === "mainnet-beta" && base.mode !== "practice",
    staleTime: 60_000, retry: false,
    queryFn: ({ signal }) => discoverSamePair(row.mintX, row.mintY, signal),
  });

  const assumption = assume.trim() ? solTextToLamports(assume) : null;

  async function compare() {
    setErr(null);
    const c = ctl.current!;
    c.invalidate();
    const job = c.begin();
    if (!job) { setErr("A timed-out request is still draining. Try again in a moment."); return; }
    const key = liveKey;
    try {
      const r = await readPlan({
        connection, cluster: base.cluster as "mainnet-beta" | "devnet", owner: base.owner, pool: row.pair, position: row.key,
        strategy: base.strategy, widen: widen.ok ? widen.range : null, destPool: dest || null, job,
      });
      job.check();
      const s: PlanSnapshot = {
        id: newId("plan"), identityKey: key, identity, createdAt: Date.now(), slot: r.slot, activeId: r.activeId,
        current: r.current, mintX: r.mintX, mintY: r.mintY, decX: r.decX, decY: r.decY, results: r.results,
        assumptionLamportsPerDay: assumption === null ? null : assumption.toString(),
      };
      const recordId = await recordFact(comparisonFact(s));
      setSnap({ s, recordId });
    } catch (e) {
      if (!(e instanceof JobCancelled)) setErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally { c.end(job); }
  }

  async function select(option: PlanOption) {
    if (!snap) return;
    const why = selectionRefusal(snap.s, liveKey, option, Date.now());
    const recordId = await recordFact(selectionFact(snap.s, option, snap.recordId));
    setLastSel({ option, recordId });
    if (!why) onReview(snap.s, option, recordId);
  }

  if (base.mode === "practice") {
    return (
      <section className="mt-8" aria-labelledby="plan-h">
        <h2 id="plan-h" className="display mb-3 text-2xl">Rebalance Planner</h2>
        <Notice tone="info" title="Practice example only">The planner compares real positions using real SDK simulations. The practice scenario has no chain state, so no amounts or costs are shown here.</Notice>
      </section>
    );
  }

  const age = snap ? Math.floor((now - snap.s.createdAt) / 1000) : 0;
  const stale = snap ? now - snap.s.createdAt > PLAN_SNAPSHOT_TTL_MS : false;
  const f = (v: string | undefined, d: number) => (v === undefined ? "—" : formatUnits(v, d, 6));
  const others = (pairs.data?.rows ?? []).filter((p) => p.pool.address !== row.pair);
  const busy = ctl.current.busy;

  return (
    <section className="mt-8" aria-labelledby="plan-h">
      <h2 id="plan-h" className="display mb-1 text-2xl">Rebalance Planner · {shortAddr(row.key)}</h2>
      <p className="mb-3 text-sm text-cream/70">Compare four routes. Planning only reads the chain — nothing is signed, and every chosen plan is rebuilt from fresh state before any review.</p>
      <Panel>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Widen · lower level" inputMode="numeric" value={lo} onChange={(e) => setLo(e.target.value)} error={!widen.ok ? widen.error : null} />
          <Field label="Widen · upper level" inputMode="numeric" value={hi} onChange={(e) => setHi(e.target.value)} hint={`Current ${row.lower}…${row.upper} (${widthOf(row)} levels)`} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="plan-dest" className="station-code text-cream/80">Move to pool (same mints)</label>
            <select id="plan-dest" value={dest} onChange={(e) => setDest(e.target.value)} className="border border-input bg-midnight p-2 text-sm text-cream">
              <option value="">— none —</option>
              {others.map((p) => <option key={p.pool.address} value={p.pool.address}>{shortAddr(p.pool.address)} · step {p.pool.bin_step ?? "—"} · {p.orientation}</option>)}
            </select>
            <span className="text-xs text-cream/60">{base.cluster !== "mainnet-beta" ? "Pool list is mainnet-only." : pairs.isPending ? "Loading exact-mint pools…" : pairs.isError ? "Pool list unavailable." : `${others.length} other pools; verified on-chain when compared.`}</span>
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Your fee-income assumption (SOL per day, optional)" inputMode="decimal" placeholder="e.g. 0.002" value={assume} onChange={(e) => setAssume(e.target.value)}
            error={assume.trim() && assumption === null ? "Up to 9 decimals" : null}
            hint="Your own number, not a forecast. Only used for a cost-recovery estimate and saved with the plan." />
          <Btn onClick={() => void compare()} disabled={busy}>{busy ? "Reading chain…" : "Compare with fresh chain state"}</Btn>
        </div>
      </Panel>

      {err && <div className="mt-3"><Notice tone="error" title="Comparison unavailable">{err}</Notice></div>}
      {busy && <div className="mt-3"><Spinner label="Running SDK simulations (read-only)" /></div>}

      {snap && (
        <div className="mt-4">
          <p className="station-code text-cream/70">
            Snapshot {age}s old · slot {snap.s.slot ?? "—"} · active level {snap.s.activeId}{stale ? " · STALE — re-run" : ""} ·{" "}
            <Link to="/app/recorder" search={{ id: snap.recordId }} className="underline">Recorder entry</Link>
          </p>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {snap.s.results.map((r) => {
              const why = selectionRefusal(snap.s, liveKey, r.option, now);
              const rec = feeRecovery(r.option, r.rentLamports, assumption);
              const decX = r.option === "move" && r.orientation === "reversed" ? snap.s.decY : snap.s.decX;
              const decY = r.option === "move" && r.orientation === "reversed" ? snap.s.decX : snap.s.decY;
              return (
                <Panel key={r.option} as="article" className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="display text-lg">{OPTION_LABEL[r.option]}</h3>
                    <span className="station-code text-amber">{simLabel(r.sim)}</span>
                  </div>
                  <RangeLine current={snap.s.current} target={r.target} active={snap.s.activeId} strategy={snap.s.identity.strategy} moved={r.option === "move"} />
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    {r.option === "keep" ? (
                      <><dt className="text-cream/60">Transaction</dt><dd>None — nothing changes</dd></>
                    ) : (
                      <>
                        <dt className="text-cream/60">Withdrawn (X / Y)</dt><dd className="font-mono">{f(r.withdrawX, snap.s.decX)} / {f(r.withdrawY, snap.s.decY)}</dd>
                        <dt className="text-cream/60">{r.option === "move" ? "Arrives at destination (X / Y)" : "Redeposited (X / Y)"}</dt><dd className="font-mono">{f(r.depositX, decX)} / {f(r.depositY, decY)}</dd>
                        {r.walletOutX !== undefined && (<><dt className="text-cream/60">Left in wallet (X / Y)</dt><dd className="font-mono">{f(r.walletOutX, snap.s.decX)} / {f(r.walletOutY, snap.s.decY)}</dd></>)}
                        <dt className="text-cream/60">SDK rent quote</dt><dd className="font-mono">{r.rentLamports === null ? "Unpriced" : `${formatUnits(r.rentLamports, 9)} SOL`}</dd>
                        <dt className="text-cream/60">Network fee · required SOL</dt><dd>Measured in the fresh review</dd>
                      </>
                    )}
                  </dl>
                  {r.reason && <p className="text-xs text-cream/70">{r.reason}</p>}
                  {r.coversActive === false && <p className="text-xs text-amber">This range does not include the current active level.</p>}
                  <p className="text-xs text-cream/70">
                    {rec.state === "estimate" ? `About ${rec.days} days to recover the quoted rent at your assumption of ${formatUnits(rec.assumptionLamportsPerDay, 9)} SOL/day (network fee excluded).` : rec.reason}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {r.option === "keep" ? (
                      <Btn size="sm" variant="ghost" onClick={() => void select("keep")}>Record “stay put”</Btn>
                    ) : (
                      <Btn size="sm" onClick={() => void select(r.option)} disabled={!!why || !!actionBlock} title={actionBlock ?? why ?? undefined}>
                        {r.option === "move" ? "Start staged move review" : "Rebuild fresh review"}
                      </Btn>
                    )}
                    {r.option !== "keep" && (actionBlock ?? why) && <span className="text-xs text-cream/60">{actionBlock ?? why}</span>}
                  </div>
                </Panel>
              );
            })}
          </div>
          {lastSel && (
            <p className="mt-3 text-sm text-cream/80">
              Saved selection “{OPTION_LABEL[lastSel.option]}” ·{" "}
              <Link to="/app/recorder" search={{ id: lastSel.recordId }} className="underline">open in Recorder</Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function simLabel(s: string) {
  return s === "none" ? "NO TX" : s === "sdk-ok" ? "SDK SIMULATED" : s === "staged-verified" ? "POOL VERIFIED · 2 STAGES" : s === "failed" ? "SIMULATION FAILED" : "NOT COMPARED";
}

/** Compact range strip: current (cream outline) vs proposed (amber, illustrative strategy shape). */
function RangeLine({ current, target, active, strategy, moved }: { current: Range; target: Range | null; active: number; strategy: "Spot" | "Curve" | "BidAsk"; moved: boolean }) {
  const t = target ?? current;
  const lo = moved ? t.lower : Math.min(current.lower, t.lower, active), hi = moved ? t.upper : Math.max(current.upper, t.upper, active);
  const span = Math.max(1, hi - lo + 1);
  const pct = (b: number) => ((b - lo) / span) * 100;
  const shape = useMemo(() => distribute(strategy, moved ? Math.round((t.lower + t.upper) / 2) : active, t.lower, t.upper), [strategy, active, t.lower, t.upper, moved]);
  const max = Math.max(1e-9, ...shape.map((s) => s.x + s.y));
  return (
    <div>
      <div className="relative h-10 border border-line bg-midnight" role="img" aria-label={`Current ${current.lower} to ${current.upper}; proposed ${t.lower} to ${t.upper}; active ${active}`}>
        {!moved && <div className="absolute inset-y-0 border-2 border-cream/60" style={{ left: `${pct(current.lower)}%`, width: `${((current.upper - current.lower + 1) / span) * 100}%` }} />}
        {shape.map((b) => (
          <div key={b.binId} className="absolute bottom-0 bg-amber/80" style={{ left: `${pct(b.binId)}%`, width: `${100 / span}%`, height: `${((b.x + b.y) / max) * 90}%` }} />
        ))}
        {!moved && <div className="absolute inset-y-0 w-0.5 bg-ochre" style={{ left: `${pct(active)}%` }} />}
      </div>
      <p className="mt-1 station-code text-cream/60">
        {moved ? "Destination" : "Now"} {moved ? "" : `${current.lower}…${current.upper} → `}{t.lower}…{t.upper} · {strategy} shape (illustrative; exact amounts above)
      </p>
    </div>
  );
}

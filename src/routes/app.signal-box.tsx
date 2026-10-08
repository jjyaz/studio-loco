import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { Btn, Field, Notice, PageHead, Panel, Segmented, Spinner, Stat } from "@/components/kit";
import { AccountPanel, signOut, useCloudSession } from "@/components/signal/account";
import { DEFAULT_RULE, SUPPORTED_COMMANDS, editRule, parseCommand, type Rule } from "@/lib/agents";
import { DEFAULT_CONFIG, validateConfig } from "@/lib/arb-math";
import { isBase58Address, shortAddr, timeAgo } from "@/lib/format";
import { MAX_WATCHES_PER_USER, STALE_AFTER_MS, TICK_MINUTES, WATCH_TTL_DAYS, handoffFor, watchHealth, type WatchHealth } from "@/lib/signal-box";
import { createWatch, editPositionWatch, getPushConfig, removePushSubscription, renewWatch, savePushSubscription, sendTestPush, setWatchStatus } from "@/lib/signal-box.functions";
import { currentPushState, subscribePush, unsubscribePush, type PushState } from "@/lib/push-client";
import { recordFact } from "@/lib/recorder-store";
import { cn } from "@/lib/utils";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

export const Route = createFileRoute("/app/signal-box")({
  validateSearch: z.object({ alert: z.string().uuid().optional() }),
  head: () => ({
    meta: [
      { title: "The Signal Box — hosted watch rules · Studio Loco" },
      { name: "description", content: "Hosted DLMM position and SOL/USDC route watches that keep checking after you close the tab. Alerts only — every move still needs a fresh review and your wallet." },
      { property: "og:title", content: "The Signal Box — Studio Loco" },
      { property: "og:description", content: "Scheduled, private watch rules with a durable alert inbox and optional browser notifications. Proposal-only." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SignalBox,
});

type Tab = "watches" | "inbox" | "health" | "notify";
interface WatchRow { id: string; kind: string; label: string; position: string | null; pool: string | null; owner: string | null; rule: unknown; status: string; revision: number; expires_at: string; last_run_at: string | null; last_ok_at: string | null; last_error: string | null; consecutive_errors: number; created_at: string; out_run: unknown }
interface AlertRow { id: string; watch_id: string | null; watch_kind: string; trigger: string; reason: string; payload: Record<string, unknown>; created_at: string; read_at: string | null; push_status: string | null; revision: number }

async function sb() { return (await import("@/integrations/supabase/client")).supabase; }

function SignalBox() {
  const { session, ready, userId, email } = useCloudSession();
  const search = Route.useSearch();
  const [tab, setTab] = useState<Tab>(search.alert ? "inbox" : "watches");
  const [online, setOnline] = useState(true);
  useEffect(() => { const f = () => setOnline(navigator.onLine); f(); window.addEventListener("online", f); window.addEventListener("offline", f); return () => { window.removeEventListener("online", f); window.removeEventListener("offline", f); }; }, []);
  return (
    <div>
      <PageHead code="ST-08 · The Signal Box" title="The lamps stay lit." cap={["live"]}
        intro={`Hosted watch rules checked every ${TICK_MINUTES} minutes by a scheduler, even with every tab closed. It observes and raises alerts only — there is no server signer, and nothing moves without a fresh review in your wallet.`} />
      <div className="relative mb-6 overflow-hidden border border-line">
        <img src={nightAsset.url} alt="A midnight train waiting at a lit signal box under a cobalt sky" className="h-36 w-full object-cover sm:h-48" loading="lazy" />
        <div className="absolute inset-x-0 bottom-0 bg-midnight/80 px-4 py-2 station-code text-cream/85">Cadence {TICK_MINUTES} min · watches expire after {WATCH_TTL_DAYS} days unless renewed · max {MAX_WATCHES_PER_USER} per account · mainnet only</div>
      </div>
      {!online && <div className="mb-4"><Notice tone="warn" title="You're offline">Readings below may be out of date. The hosted scheduler keeps running regardless.</Notice></div>}
      {!ready ? <Spinner label="Checking account" /> : !session ? <AccountPanel purpose="use hosted watches" /> : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="station-code text-cream/70">Signed in as {email ?? "account"} · private to this account</p>
            <Btn size="sm" variant="ghost" onClick={() => void signOut()}>Sign out</Btn>
          </div>
          <div role="tablist" aria-label="Signal Box sections" className="mb-6 flex overflow-x-auto border-b border-line">
            {([["watches", "Watches"], ["inbox", "Alert inbox"], ["health", "Scheduler health"], ["notify", "Notifications"]] as const).map(([t, l]) => (
              <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("station-code min-h-11 shrink-0 border-b-2 px-4", tab === t ? "border-amber text-amber" : "border-transparent text-cream/75")}>{l}</button>
            ))}
          </div>
          {tab === "watches" && <Watches userId={userId!} />}
          {tab === "inbox" && <Inbox userId={userId!} focus={search.alert} />}
          {tab === "health" && <Health userId={userId!} />}
          {tab === "notify" && <Notify />}
        </>
      )}
      <p className="mt-8 text-xs text-cream/60">Wallet acceptance remains user-run: see <Link to="/app/checks" className="underline">Wallet Checks</Link> and the pilot procedure in <Link to="/docs" className="underline">Docs</Link>. Ordinary Meteora DLMM only.</p>
    </div>
  );
}

const HEALTH_STYLE: Record<WatchHealth, string> = { healthy: "border-success text-success", stale: "border-amber text-amber", erroring: "border-destructive text-destructive", paused: "border-cream/50 text-cream/70", expired: "border-cream/50 text-cream/60", waiting: "border-cream/60 text-cream/80" };

function useWatches(userId: string) {
  return useQuery({ queryKey: ["signal-watches", userId], refetchInterval: 30_000, queryFn: async () => {
    const { data, error } = await (await sb()).from("signal_watches").select("id,kind,label,position,pool,owner,rule,status,revision,expires_at,last_run_at,last_ok_at,last_error,consecutive_errors,created_at,out_run").order("created_at", { ascending: false });
    if (error) throw error; return data as WatchRow[];
  } });
}

function Watches({ userId }: { userId: string }) {
  const q = useWatches(userId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  if (q.isPending) return <Spinner label="Reading watches" />;
  if (q.isError) return <Notice tone="error" title="Couldn't read watches" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{(q.error as Error).message}</Notice>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-4">
        {!q.data.length && <Panel><p className="text-cream/80">No watches yet. Add a verified position or the SOL/USDC route watch. The first observation lands at the next {TICK_MINUTES}-minute tick.</p></Panel>}
        {q.data.map((w) => <WatchCard key={w.id} w={w} now={now} onChange={() => q.refetch()} />)}
      </div>
      <NewWatch count={q.data.length} hasArb={q.data.some((w) => w.kind === "arb")} onCreated={() => q.refetch()} />
    </div>
  );
}

function WatchCard({ w, now, onChange }: { w: WatchRow; now: number; onChange: () => void }) {
  const status = useServerFn(setWatchStatus), renew = useServerFn(renewWatch);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const h = watchHealth(w, now);
  const obs = useQuery({ queryKey: ["signal-obs", w.id], enabled: open, refetchInterval: open ? 30_000 : false, queryFn: async () => {
    const { data, error } = await (await sb()).from("signal_observations").select("id,observed_at,ok,summary,error,revision").eq("watch_id", w.id).order("observed_at", { ascending: false }).limit(20);
    if (error) throw error; return data;
  } });
  const act = async (f: () => Promise<{ ok: boolean; error?: string }>) => { setBusy(true); setErr(null); try { const r = await f(); if (!r.ok) setErr(r.error ?? "Failed"); onChange(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const del = () => act(async () => { if (!confirm("Delete this watch? Its observations are removed; alerts stay in your inbox.")) return { ok: true }; const { error } = await (await sb()).from("signal_watches").delete().eq("id", w.id); return error ? { ok: false, error: error.message } : { ok: true }; });
  const rule = (w.rule as { rule?: Rule })?.rule;
  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="station-code text-cream/60">{w.kind === "position" ? "Position watch" : "SOL/USDC route watch"} · rev {w.revision}</p>
          <h3 className="display text-xl">{w.label || (w.position ? `Position ${shortAddr(w.position)}` : "Two-pool route")}</h3>
          {w.position && <p className="station-code text-cream/60">Pool {shortAddr(w.pool!)} · owner {shortAddr(w.owner!)}{rule?.baseline ? ` · baseline bin ${rule.baseline.activeId}` : ""}</p>}
        </div>
        <span className={cn("station-code border px-2 py-1", HEALTH_STYLE[h])}>{h}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Last run" value={w.last_run_at ? timeAgo(Date.parse(w.last_run_at)) : "—"} />
        <Stat label="Last good read" value={w.last_ok_at ? timeAgo(Date.parse(w.last_ok_at)) : "—"} />
        <Stat label="Errors in a row" value={String(w.consecutive_errors)} />
        <Stat label="Expires" value={new Date(w.expires_at).toLocaleDateString()} sub={Date.parse(w.expires_at) < now ? "expired" : undefined} />
      </div>
      {w.last_error && <p className="mt-2 text-sm text-destructive">Last error: {w.last_error}</p>}
      {h === "stale" && <p className="mt-2 text-sm text-amber">No successful observation in {Math.round(STALE_AFTER_MS / 60_000)} min. Treat the position as unobserved, not calm.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {w.status === "active" ? <Btn size="sm" variant="line" disabled={busy} onClick={() => act(() => status({ data: { id: w.id, status: "paused" } }))}>Pause</Btn> : <Btn size="sm" disabled={busy} onClick={() => act(() => status({ data: { id: w.id, status: "active" } }))}>Resume</Btn>}
        <Btn size="sm" variant="line" disabled={busy} onClick={() => act(() => renew({ data: { id: w.id } }))}>Renew {WATCH_TTL_DAYS} days</Btn>
        <Btn size="sm" variant="ghost" disabled={busy} onClick={del}>Delete</Btn>
        <Btn size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide observations" : "Observations"}</Btn>
      </div>
      {rule && w.kind === "position" && <RuleEdit id={w.id} rule={rule} onSaved={onChange} />}
      {err && <p className="mt-2 text-sm text-destructive" role="alert">{err}</p>}
      {open && (
        <div className="mt-3 max-h-72 overflow-auto border border-line">
          {obs.isPending ? <Spinner label="Reading observations" /> : obs.isError ? <p className="p-3 text-sm text-destructive">Couldn't read observations.</p> : !obs.data?.length ? <p className="p-3 text-sm text-cream/70">No observations yet — the next tick is at most {TICK_MINUTES} min away.</p> : (
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="station-code text-cream/60"><tr><th className="p-2">When</th><th className="p-2">Rev</th><th className="p-2">Reading</th></tr></thead>
              <tbody>{obs.data.map((o) => <tr key={o.id} className="border-t border-line"><td className="p-2 whitespace-nowrap">{new Date(o.observed_at).toLocaleTimeString()}</td><td className="p-2">{o.revision}</td><td className="p-2">{o.ok ? summaryText(o.summary as Record<string, unknown>) : <span className="text-destructive">Unavailable — {o.error}</span>}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

function summaryText(s: Record<string, unknown>): string {
  if ("routes" in s) return `${s["routes"]} routes · ${s["profitable"]} met floor · ${s["evidence"]}${s["best"] ? ` · best ${s["best"]} ${s["bestExpectedProfitLamports"] ?? "—"} lamports` : ""}`;
  const vol = s["vol"] as { state: string; pct?: number; reason?: string } | null;
  return `${s["state"]} · active ${s["activeId"]} in ${s["lower"]}–${s["upper"]}${Number(s["observedOutMin"]) ? ` · observed out ${s["observedOutMin"]} min` : ""}${vol ? ` · vol ${vol.state === "ok" ? `${vol.pct}%` : "unavailable"}` : ""}${s["trigger"] ? ` · trigger ${s["trigger"]}` : ""}`;
}

function RuleEdit({ id, rule, onSaved }: { id: string; rule: Rule; onSaved: () => void }) {
  const edit = useServerFn(editPositionWatch);
  const [cmd, setCmd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function apply(e: React.FormEvent) {
    e.preventDefault();
    const p = parseCommand(cmd);
    if (!p.ok) { setMsg(p.error); return; }
    setBusy(true);
    try { const r = await edit({ data: { id, rule: editRule(rule, p.patch) } }); setMsg(r.ok ? `Applied: ${p.summary.join("; ")}. Re-armed at bin ${r.baseline}; in-flight results discarded.` : r.error); if (r.ok) { setCmd(""); onSaved(); } }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={apply} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-[220px] flex-1"><Field label="Change rule (rule assistant)" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="alert me within 3 bins of the edge" /></div>
      <Btn size="sm" type="submit" disabled={busy || !cmd.trim()}>Apply & re-arm</Btn>
      {msg && <p className="w-full text-sm text-cream/80" role="status">{msg}</p>}
    </form>
  );
}

function NewWatch({ count, hasArb, onCreated }: { count: number; hasArb: boolean; onCreated: () => void }) {
  const create = useServerFn(createWatch);
  const [kind, setKind] = useState<"position" | "arb">("position");
  const [owner, setOwner] = useState(""), [position, setPosition] = useState(""), [pool, setPool] = useState(""), [label, setLabel] = useState("");
  const [rule, setRule] = useState<Rule>({ ...DEFAULT_RULE, rebalanceOnExit: true, edgeBuffer: 3 });
  const [cmd, setCmd] = useState("");
  const [inputSol, setInputSol] = useState(DEFAULT_CONFIG.inputSol), [minProfit, setMinProfit] = useState(DEFAULT_CONFIG.minProfitSol);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const arbCfg = useMemo(() => validateConfig({ ...DEFAULT_CONFIG, inputSol, minProfitSol: minProfit }), [inputSol, minProfit]);
  const full = count >= MAX_WATCHES_PER_USER;
  const addrOk = isBase58Address(owner) && isBase58Address(position) && isBase58Address(pool);
  function applyCmd() { const p = parseCommand(cmd); if (!p.ok) { setMsg({ tone: "error", text: p.error }); return; } setRule((r) => editRule(r, p.patch)); setMsg({ tone: "info", text: `Translated: ${p.summary.join("; ")}` }); setCmd(""); }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const r = kind === "arb" ? await create({ data: { kind: "arb", label, config: arbCfg.ok ? arbCfg.cfg : null } })
        : await create({ data: { kind: "position", label, owner: owner.trim(), position: position.trim(), pool: pool.trim(), rule } });
      if (!r.ok) setMsg({ tone: "error", text: r.error });
      else { setMsg({ tone: "info", text: "baseline" in r && r.baseline !== undefined ? `Verified on chain and armed at bin ${r.baseline} (range ${r.range?.[0]}–${r.range?.[1]}).` : "Route watch created." }); onCreated(); }
    } catch (err) { setMsg({ tone: "error", text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }
  return (
    <Panel tone="cobalt" as="div">
      <h2 className="display text-2xl">New watch</h2>
      <div className="mt-3"><Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: "position", label: "DLMM position" }, { value: "arb", label: "SOL/USDC route" }]} /></div>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <Field label="Label (optional)" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        {kind === "position" ? (
          <>
            <Field label="Position owner (public address)" value={owner} onChange={(e) => setOwner(e.target.value)} error={owner && !isBase58Address(owner) ? "Not a Solana address" : null} />
            <Field label="Position account" value={position} onChange={(e) => setPosition(e.target.value)} error={position && !isBase58Address(position) ? "Not a Solana address" : null} />
            <Field label="Pool (lb pair)" value={pool} onChange={(e) => setPool(e.target.value)} error={pool && !isBase58Address(pool) ? "Not a Solana address" : null} hint="Verified on chain: DLMM program, PositionV2 type, pool and owner binding, exact mints." />
            <div className="flex items-end gap-2"><div className="flex-1"><Field label="Rule assistant" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="prepare a 50% withdrawal after 15 minutes out of range" /></div><Btn type="button" size="sm" variant="line" onClick={applyCmd} disabled={!cmd.trim()}>Translate</Btn></div>
            <details className="text-xs text-cream/70"><summary className="cursor-pointer station-code">Supported commands</summary><ul className="mt-2 list-disc pl-4">{SUPPORTED_COMMANDS.map((c) => <li key={c}>{c}</li>)}</ul></details>
            <ul className="station-code text-cream/80">
              <li>Edge buffer: {rule.edgeBuffer ?? "off"} bins</li>
              <li>Price move: {rule.priceMovePct !== null ? `${rule.priceMovePct}%` : "off"}</li>
              <li>Leaving range: {rule.rebalanceOnExit ? "propose rebalance" : "off"}</li>
              <li>Out of range: {rule.outMinutes !== null ? `${rule.outWithdrawPct}% withdrawal after ${rule.outMinutes} observed min` : "off"}</li>
              <li>Volatility: {rule.volatility ? `${rule.volatility.frame} × ${rule.volatility.candles} > ${rule.volatility.thresholdPct}% → ${rule.volatility.withdrawPct}%` : "off"}</li>
              <li>Cooldown: {rule.cooldownMin} min</li>
            </ul>
          </>
        ) : (
          <>
            <Field label="Input SOL" value={inputSol} onChange={(e) => setInputSol(e.target.value)} />
            <Field label="Minimum net profit (SOL)" value={minProfit} onChange={(e) => setMinProfit(e.target.value)} error={!arbCfg.ok ? arbCfg.error : null} hint="Same validator, cost estimate and floor as Dispatch. Alerts only when a read-only scan meets the floor; a wallet-specific requote is still required." />
            {hasArb && <p className="text-sm text-amber">One route watch per account.</p>}
          </>
        )}
        <Btn type="submit" disabled={busy || full || (kind === "position" ? !addrOk : !arbCfg.ok || hasArb)}>{busy ? "Verifying…" : full ? `Limit ${MAX_WATCHES_PER_USER} reached` : "Verify & create watch"}</Btn>
      </form>
      {msg && <div className="mt-3"><Notice tone={msg.tone} title={msg.tone === "error" ? "Not created" : "Done"}>{msg.text}</Notice></div>}
    </Panel>
  );
}

function Inbox({ userId, focus }: { userId: string; focus?: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["signal-alerts", userId], refetchInterval: 30_000, queryFn: async () => {
    const { data, error } = await (await sb()).from("signal_alerts").select("id,watch_id,watch_kind,trigger,reason,payload,created_at,read_at,push_status,revision").order("created_at", { ascending: false }).limit(100);
    if (error) throw error; return data as AlertRow[];
  } });
  const [unreadOnly, setUnreadOnly] = useState(false);
  if (q.isPending) return <Spinner label="Reading inbox" />;
  if (q.isError) return <Notice tone="error" title="Couldn't read alerts" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{(q.error as Error).message}</Notice>;
  const rows = q.data.filter((a) => !unreadOnly || !a.read_at);
  const mark = async (id: string) => { await (await sb()).from("signal_alerts").update({ read_at: new Date().toISOString() }).eq("id", id); void qc.invalidateQueries({ queryKey: ["signal-alerts", userId] }); };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-cream/80">An alert is an observation, not an approval. Opening it refetches fresh chain state and prepares a <strong>new</strong> review with the usual guards and fee caps.</p>
        <label className="station-code flex items-center gap-2"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
      </div>
      {!rows.length ? <Panel><p className="text-cream/80">No alerts. Quiet lamps mean no rule triggered in a successful observation — check Scheduler health and each watch's last good read before treating that as calm.</p></Panel> : (
        <ul className="flex flex-col gap-3">
          {rows.map((a) => {
            const h = handoffFor(a);
            return (
              <li key={a.id} className={cn("ticket p-4", focus === a.id && "ring-2 ring-amber", !a.read_at && "border-l-4 border-amber")}>
                <div className="flex flex-wrap justify-between gap-2"><span className="station-code text-amber">{a.trigger}</span><span className="station-code text-cream/60">{new Date(a.created_at).toLocaleString()} · {a.push_status ?? "inbox"}</span></div>
                <p className="mt-2 text-sm">{a.reason}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link to={h.to} search={h.search as never} className="station-code min-h-10 border border-amber px-3 py-2 text-amber hover:bg-amber hover:text-midnight"
                    onClick={() => { void mark(a.id); void recordFact({ kind: "alert-handoff", title: `Alert ${a.trigger} opened`, route: "/app/signal-box", cluster: "mainnet-beta", links: { alertId: a.id, watchId: a.watch_id ?? undefined }, context: { trigger: a.trigger, watchKind: a.watch_kind, revision: a.revision }, detail: a.reason }); }}>
                    Open fresh review in {a.watch_kind === "arb" ? "Dispatch" : "Observatory"} →
                  </Link>
                  {!a.read_at && <Btn size="sm" variant="ghost" onClick={() => mark(a.id)}>Mark read</Btn>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Health({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ["signal-ticks", userId], refetchInterval: 60_000, queryFn: async () => {
    const { data, error } = await (await sb()).from("signal_ticks").select("id,started_at,finished_at,processed,errors,alerts,note").order("started_at", { ascending: false }).limit(24);
    if (error) throw error; return data;
  } });
  if (q.isPending) return <Spinner label="Reading scheduler" />;
  if (q.isError) return <Notice tone="error" title="Scheduler health unavailable">{(q.error as Error).message}</Notice>;
  const last = q.data[0];
  const lastAge = last ? Date.now() - Date.parse(last.started_at) : Infinity;
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Cadence" value={`${TICK_MINUTES} min`} />
        <Stat label="Last tick" value={last ? timeAgo(Date.parse(last.started_at)) : "—"} />
        <Stat label="Scheduler" value={lastAge < 3 * TICK_MINUTES * 60_000 ? "Running" : "Stale"} />
        <Stat label="Ticks shown" value={String(q.data.length)} />
      </div>
      <div className="overflow-x-auto border border-line">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="station-code text-cream/60"><tr><th className="p-2">Started</th><th className="p-2">Duration</th><th className="p-2">Watches</th><th className="p-2">Errors</th><th className="p-2">Alerts</th><th className="p-2">Note</th></tr></thead>
          <tbody>{q.data.map((t) => <tr key={t.id} className="border-t border-line"><td className="p-2 whitespace-nowrap">{new Date(t.started_at).toLocaleString()}</td><td className="p-2">{t.finished_at ? `${((Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000).toFixed(1)}s` : "unfinished"}</td><td className="p-2">{t.processed}</td><td className="p-2">{t.errors}</td><td className="p-2">{t.alerts}</td><td className="p-2">{t.note ?? ""}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-cream/60">Counts are global across all accounts and contain no personal data. A tick that finds another tick still running exits without work.</p>
    </div>
  );
}

function Notify() {
  const cfg = useServerFn(getPushConfig), save = useServerFn(savePushSubscription), remove = useServerFn(removePushSubscription), test = useServerFn(sendTestPush);
  const [state, setState] = useState<PushState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void currentPushState().then(setState); }, []);
  async function enable() {
    setBusy(true); setMsg(null);
    try {
      const c = await cfg();
      if (!c.available) { setState("not-configured"); return; }
      const s = await subscribePush(c.publicKey);
      if (typeof s === "string") { setState(s); return; }
      const r = await save({ data: s });
      setMsg(r.ok ? "This browser will receive Signal Box alerts." : r.error);
      setState(await currentPushState());
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true);
    try { const ep = await unsubscribePush(); if (ep) await remove({ data: { endpoint: ep } }); setMsg("Unsubscribed on this browser."); setState(await currentPushState()); } finally { setBusy(false); }
  }
  const copy: Record<PushState, string> = {
    unsupported: "This browser doesn't support Web Push. Alerts still land in your inbox.",
    "open-in-new-tab": "Notifications can't be enabled inside an embedded preview. Open Studio Loco in its own tab.",
    default: "Off. Turning this on asks your browser for permission.",
    denied: "Blocked in your browser's site settings. Allow notifications for this site there, then try again.",
    subscribed: "On for this browser.",
    "not-subscribed": "Off for this browser.",
    "not-configured": "Push sending isn't configured on the server. Alerts still land in your inbox.",
  };
  return (
    <Panel>
      <h2 className="display text-2xl">Browser notifications</h2>
      <p className="mt-2 max-w-2xl text-sm text-cream/80">Optional. Studio Loco never requests permission on its own. Clicking a notification opens the alert in your inbox, from which you open a fresh review. Email delivery isn't offered: it would need a separate mail provider, so the inbox and Web Push are the channels.</p>
      <p className="mt-3 station-code" role="status">{state ? copy[state] : "Checking…"}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {state !== "subscribed" ? <Btn onClick={enable} disabled={busy || state === "unsupported" || state === "open-in-new-tab"}>Enable on this browser</Btn> : <Btn variant="line" onClick={disable} disabled={busy}>Unsubscribe</Btn>}
        {state === "subscribed" && <Btn variant="ghost" disabled={busy} onClick={async () => { const r = await test(); setMsg(r.ok ? `Test sent to ${r.sent}/${r.total} device(s).` : r.error); }}>Send test</Btn>}
      </div>
      {msg && <p className="mt-2 text-sm text-cream/85">{msg}</p>}
    </Panel>
  );
}

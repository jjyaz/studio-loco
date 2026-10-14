import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ArrowDownUp,
  ArrowRight,
  Check,
  Download,
  Fingerprint,
  Gauge,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  TrainFront,
  Waypoints,
} from "lucide-react";
import { Btn, Field, Notice, Panel, Spinner, Stat, btn } from "@/components/kit";
import { useSettings } from "@/lib/settings";
import { JobCancelled, JobControl, type Job } from "@/lib/job-control";
import { listJourneys, subscribeJourney } from "@/lib/journey-store";
import type { Journey } from "@/lib/journey";
import { parseUnits, formatUnits } from "@/lib/amount";
import { shortAddr } from "@/lib/format";
import { redact } from "@/lib/recorder";
import {
  listMissions,
  subscribeConductor,
  saveNewMission,
  appendMissionPolicy,
  setMissionStatus,
  removeMission,
} from "@/lib/conductor-store";
import { readConductorSnapshot } from "@/lib/conductor-chain";
import { observeConductorMission, repairConductorRecorder } from "@/lib/conductor-capture";
import {
  CONDUCTOR_ADAPTER,
  MISSION_ACTIONS,
  MissionPolicy,
  MissionRaw,
  createConductorMission,
  sealMissionPolicy,
  evaluateMission,
  exportMission,
  previewMissionAction,
  missionPolicyRecordId,
  type ConductorMission,
  type MissionSnapshot,
  type MissionState,
  type MissionScope,
} from "@/lib/conductor";
import hero from "@/assets/studio-loco-night-station.png.asset.json";

const date = (n: number) => new Date(n).toLocaleString();
const token = (mint: string, side: string) =>
  mint === "So11111111111111111111111111111111111111112"
    ? "WSOL"
    : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : `Token ${side}`;
const amount = (n: string, decimals: number) => formatUnits(n, decimals);
const inputAmount = (n: string, decimals: number) => formatUnits(n, decimals).replaceAll(",", "");
const err = (e: unknown) =>
  redact(e instanceof Error ? e.message : "Read unavailable").slice(0, 300);
const tone = (s: MissionState) =>
  s === "met" ? "text-success" : s === "unmet" ? "text-amber" : "text-cream/60";
const stateText = { met: "Mission met", unmet: "Needs attention", unknown: "Evidence incomplete" };
type PolicyForm = {
  probesX: string;
  probesY: string;
  impact: string;
  swapFee: string;
  capX: string;
  capY: string;
  reserve: string;
  networkFee: string;
  cooldown: string;
  age: string;
  lifetime: string;
  actions: (typeof MISSION_ACTIONS)[number][];
};
const defaults = (): PolicyForm => ({
  probesX: "0.01, 0.1, 1",
  probesY: "1, 10, 100",
  impact: "50",
  swapFee: "100",
  capX: "0",
  capY: "0",
  reserve: "0.01",
  networkFee: "0.0001",
  cooldown: "5",
  age: "120",
  lifetime: "24",
  actions: ["rebalance", "claim", "withdraw"],
});
function fromPolicy(p: MissionPolicy): PolicyForm {
  return {
    probesX: p.probesX.map((n) => inputAmount(n, p.scope.decimalsX)).join(", "),
    probesY: p.probesY.map((n) => inputAmount(n, p.scope.decimalsY)).join(", "),
    impact: String(p.maxImpactBps),
    swapFee: String(p.maxSwapFeeBps),
    capX: inputAmount(p.maxDeployXRaw, p.scope.decimalsX),
    capY: inputAmount(p.maxDeployYRaw, p.scope.decimalsY),
    reserve: inputAmount(p.minSolReserveLamports, 9),
    networkFee: inputAmount(p.maxNetworkFeeLamports, 9),
    cooldown: String(p.cooldownMs / 60000),
    age: String(p.maxAgeMs / 1000),
    lifetime: "24",
    actions: [...p.allowedActions],
  };
}
function raw(text: string, decimals: number): string {
  const parsed = parseUnits(text, decimals);
  if (!parsed.ok) throw new Error(parsed.error);
  return MissionRaw.parse(parsed.raw.toString());
}
function buildPolicy(form: PolicyForm, scope: MissionScope): MissionPolicy {
  const ladder = (text: string, decimals: number) => text.split(",").map((s) => raw(s, decimals));
  return MissionPolicy.parse({
    v: 1,
    adapter: CONDUCTOR_ADAPTER,
    scope,
    probesX: ladder(form.probesX, scope.decimalsX),
    probesY: ladder(form.probesY, scope.decimalsY),
    maxImpactBps: Number(form.impact),
    maxSwapFeeBps: Number(form.swapFee),
    maxDeployXRaw: raw(form.capX, scope.decimalsX),
    maxDeployYRaw: raw(form.capY, scope.decimalsY),
    minSolReserveLamports: raw(form.reserve, 9),
    maxNetworkFeeLamports: raw(form.networkFee, 9),
    allowedActions: form.actions,
    cooldownMs: Number(form.cooldown) * 60000,
    maxAgeMs: Number(form.age) * 1000,
    expiresAt: Date.now() + Number(form.lifetime) * 3600000,
    approval: "fresh-wallet-review",
  });
}
function Badge({ state, children }: { state: MissionState; children?: React.ReactNode }) {
  return (
    <span
      className={`station-code inline-flex items-center gap-2 border border-current/30 px-3 py-1.5 ${tone(state)}`}
    >
      <span className="size-1.5 bg-current" />
      {children ?? stateText[state]}
    </span>
  );
}

export function Conductor({ initial = {} }: { initial?: { mission?: string; journey?: string } }) {
  const { connection } = useConnection(),
    wallet = useWallet();
  const { settings, hydrated } = useSettings();
  const live = hydrated && !settings.practice && settings.cluster === "mainnet-beta";
  const rpcKind = settings.rpc["mainnet-beta"] ? ("custom" as const) : ("relay" as const);
  const [missions, setMissions] = useState<ConductorMission[]>([]),
    [journeys, setJourneys] = useState<Journey[]>([]);
  const [selected, setSelected] = useState(initial.mission ?? ""),
    [ready, setReady] = useState(false);
  const [error, setError] = useState(""),
    [storageError, setStorageError] = useState(""),
    [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false),
    [removing, setRemoving] = useState(false);
  const [pool, setPool] = useState(""),
    [owner, setOwner] = useState(""),
    [sourceId, setSourceId] = useState(initial.journey ?? "");
  const [label, setLabel] = useState("My liquidity mission"),
    [draft, setDraft] = useState<PolicyForm>(defaults);
  const [inspected, setInspected] = useState<MissionSnapshot | null>(null);
  const [now, setNow] = useState(Date.now),
    [busy, setBusy] = useState(false);
  const ctl = useRef(new JobControl()),
    mounted = useRef(false),
    reloadVersion = useRef(0);
  const current = missions.find((m) => m.id === selected),
    currentRef = useRef(current);
  currentRef.current = current;
  const p = current?.policies.at(-1),
    scope = p?.policy.scope;
  const latest = current?.samples.at(-1),
    sample = latest?.policyRevision === p?.revision ? latest : undefined;
  const health = p && sample ? evaluateMission(p.policy, sample.snapshot, now) : null;
  const currentState = current?.lastError ? "unknown" : (health?.state ?? "unknown");

  async function reload() {
    const version = ++reloadVersion.current;
    const result = await Promise.allSettled([listMissions(), listJourneys()]);
    if (!mounted.current || version !== reloadVersion.current) return;
    const [a, b] = result;
    if (a.status === "fulfilled") {
      setMissions(a.value);
      setSelected((previous) => previous || a.value[0]?.id || "");
    }
    if (b.status === "fulfilled") setJourneys(b.value.filter((j) => j.kind === "position"));
    setStorageError(
      result
        .filter((r) => r.status === "rejected")
        .map((r) => err((r as PromiseRejectedResult).reason))
        .join(" "),
    );
    setReady(true);
  }
  useEffect(() => {
    mounted.current = true;
    ctl.current.mounted = true;
    const off = ctl.current.subscribe(() => {
      if (mounted.current) setBusy(ctl.current.busy);
    });
    const a = subscribeConductor(() => void reload()),
      b = subscribeJourney(() => void reload());
    void reload();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      reloadVersion.current++;
      ctl.current.unmount();
      off();
      a();
      b();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    ctl.current.invalidate();
    setInspected(null);
    setError("");
  }, [connection, live, rpcKind]);
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const m = currentRef.current;
      if (
        document.visibilityState !== "visible" ||
        m?.status !== "monitoring" ||
        Date.now() >= m.policies.at(-1)!.policy.expiresAt
      )
        return;
      void observe(m.id);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") ctl.current.invalidate();
      else tick();
    };
    const timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      ctl.current.invalidate();
    };
  }, [live, connection, rpcKind]);
  useEffect(() => {
    if (initial.journey && !pool && journeys.length) {
      const j = journeys.find((j) => j.id === initial.journey);
      if (j) {
        setPool(j.pool);
        setOwner(j.owner);
        setSourceId(j.id);
        setCreating(true);
      }
    }
  }, [journeys]);
  function edited(fn: () => void, identity = false) {
    ctl.current.invalidate();
    setError("");
    setMessage("");
    if (identity) setInspected(null);
    fn();
  }
  async function run(text: string, work: (job: Job) => Promise<void>) {
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setMessage(text);
    try {
      await work(job);
      job.check();
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        setError(err(e));
        setMessage("");
      }
    } finally {
      ctl.current.end(job);
      if (mounted.current) await reload();
    }
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!live) return;
    await run("Verifying mainnet pool, token precision and owner read scope…", async (job) => {
      const j = journeys.find((j) => j.id === sourceId);
      if (sourceId && !j)
        throw new Error(
          "The selected Journey is no longer available. Choose a current source before inspecting.",
        );
      const s = await readConductorSnapshot(
        connection,
        {
          pool: pool.trim(),
          owner: owner.trim(),
          probesX: [],
          probesY: [],
          position: j ? { account: j.account, journeyId: j.id } : null,
        },
        job,
        rpcKind,
      );
      setInspected(s);
      setMessage(
        "Identity checked. Review the sizes and local policy, then seal a fresh mission baseline.",
      );
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!live || !inspected) return;
    await run("Sealing policy, quoting both directions and saving the baseline…", async (job) => {
      const policy = await sealMissionPolicy(buildPolicy(draft, inspected.scope));
      job.check();
      const s = await readConductorSnapshot(
        connection,
        {
          pool: inspected.scope.pool,
          owner: inspected.scope.owner,
          probesX: policy.policy.probesX,
          probesY: policy.policy.probesY,
          expectedScope: inspected.scope,
          position: inspected.scope.position
            ? { account: inspected.scope.position, journeyId: inspected.scope.journeyId! }
            : null,
          minimumSlot: inspected.slot,
        },
        job,
        rpcKind,
      );
      const m = await job.step(
        saveNewMission(createConductorMission(label, policy, s)),
        5000,
        "Persistent mission baseline",
      );
      setSelected(m.id);
      setCreating(false);
      setEditing(false);
      setInspected(null);
      try {
        await repairConductorRecorder(m.id, job);
        setMessage(
          "Mission and baseline saved. Recorder evidence linked. Monitoring starts only when you enable it.",
        );
      } catch (e) {
        if (!job.alive()) throw e;
        setMessage(`Mission saved. Recorder repair pending: ${err(e)}`);
      }
    });
  }
  async function observe(id: string) {
    if (!live) return;
    await run("Reading independent quote probes and current inventory…", async (job) => {
      const result = await observeConductorMission(connection, id, job, rpcKind);
      setMessage(
        result.recorderError
          ? `Observation saved. Recorder repair pending: ${result.recorderError}`
          : "Fresh observation saved and linked to Flight Recorder.",
      );
    });
  }
  async function revise(event: FormEvent) {
    event.preventDefault();
    if (!current || !p || !live) return;
    await run("Sealing a new immutable policy revision…", async (job) => {
      const policy = await sealMissionPolicy(buildPolicy(draft, p.policy.scope), p.revision + 1);
      job.check();
      await job.step(
        appendMissionPolicy(current.id, current.revision, policy),
        5000,
        "Policy revision",
      );
      setEditing(false);
      try {
        await repairConductorRecorder(current.id, job);
      } catch (e) {
        if (!job.alive()) throw e;
      }
      setMessage(
        "New policy sealed. Monitoring is paused. Observe again to measure this revision; earlier history is preserved.",
      );
    });
  }
  const showBuilder = creating || (ready && missions.length === 0);
  const source = journeys.find((j) => j.id === sourceId);
  return (
    <div className="flex flex-col gap-7 pb-10">
      <section className="relative isolate overflow-hidden border border-line bg-navy">
        <img
          src={hero.url}
          alt="A warmly lit locomotive arriving at Studio Loco’s mountain observatory"
          className="absolute inset-0 -z-20 h-full w-full object-cover object-[65%_48%] opacity-60"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-midnight via-midnight/90 to-midnight/10" />
        <div className="grid gap-8 px-6 py-10 md:grid-cols-[1.3fr_0.7fr] md:px-10 md:py-14">
          <div>
            <p className="station-code flex items-center gap-2 text-amber">
              <TrainFront size={16} /> Observatory · Platform 05{" "}
              <span className="ml-2 border border-amber/40 px-2 py-1">Live reads · v1</span>
            </p>
            <h1 className="display mt-5 text-5xl leading-[0.98] text-cream md:text-7xl">
              The Conductor<span className="text-amber">.</span>
            </h1>
            <p className="display mt-5 max-w-lg text-2xl text-cream md:text-3xl">
              Give liquidity a measurable mission.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-cream/75">
              A control room for Meteora market depth. Set the objective, seal the rules and keep
              evidence of every observation.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Btn
                onClick={() =>
                  edited(() => {
                    setCreating(true);
                    setEditing(false);
                    setDraft(defaults());
                  })
                }
              >
                <Plus size={16} /> New mission
              </Btn>
              <Link to="/app/journey" className={btn({ variant: "line" })}>
                Open Journey <ArrowRight size={16} />
              </Link>
            </div>
          </div>
          <div className="self-end border border-amber/35 bg-midnight/90 p-5 backdrop-blur-sm">
            <p className="station-code mb-4 text-amber">The mission loop</p>
            {[
              [Gauge, "01", "Measure the market", "Independent quotes in both directions."],
              [ShieldCheck, "02", "Seal the envelope", "Exact token caps. Explicit local rules."],
              [
                Fingerprint,
                "03",
                "Retain the evidence",
                "Versioned policies → observations → Recorder.",
              ],
            ].map(([Icon, n, title, detail]) => {
              const I = Icon as typeof Gauge;
              return (
                <div key={String(n)} className="flex gap-3 border-t border-line py-3">
                  <I size={19} className="mt-1 shrink-0 text-amber" />
                  <div>
                    <p className="text-sm text-cream">
                      <span className="mr-2 font-mono text-cream/45">{String(n)}</span>
                      {String(title)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-cream/60">{String(detail)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line bg-midnight/80 px-6 py-3 station-code text-[0.65rem] text-cream/65 md:px-10">
          <span>Ordinary DLMM · mainnet</span>
          <span>Two arrays / direction</span>
          <span>Watch-only · no signing</span>
          <span>Local policy · fresh evidence</span>
        </div>
      </section>
      {!live && (
        <Notice tone="warn" title="Live mainnet mode required">
          Turn off Practice and select Mainnet in Settings to read or monitor missions. Saved
          evidence remains viewable.
        </Notice>
      )}
      {storageError && (
        <Notice tone="error" title="Persistent storage unavailable">
          {storageError}
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Conductor could not complete this step">
          {error}
        </Notice>
      )}
      {busy ? (
        <Spinner label={message || "Reading Conductor evidence"} />
      ) : (
        message && <Notice title="Conductor status">{message}</Notice>
      )}
      {!ready && <Spinner label="Opening your mission journal" />}

      {showBuilder && (
        <Panel>
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="station-code text-amber">01 · Mission scope</p>
              <h2 className="display mt-2 text-3xl">Start with a real market.</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-cream/65">
                Choose a tracked LP or enter a pool and an address to observe. No wallet connection
                is needed. A local policy is unsigned and does not prove ownership.
              </p>
            </div>
            {missions.length > 0 && (
              <Btn variant="ghost" onClick={() => edited(() => setCreating(false))}>
                Close
              </Btn>
            )}
          </div>
          <form onSubmit={inspect} className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label htmlFor="mission-journey" className="station-code text-cream/75">
                Optional tracked position
              </label>
              <select
                id="mission-journey"
                value={sourceId}
                onChange={(e) =>
                  edited(() => {
                    const j = journeys.find((j) => j.id === e.target.value);
                    setSourceId(e.target.value);
                    if (j) {
                      setPool(j.pool);
                      setOwner(j.owner);
                    }
                  }, true)
                }
                className="mt-2 min-h-11 w-full border border-line bg-midnight px-3 text-sm"
              >
                <option value="">Pool-only mission · no attributed LP inventory</option>
                {journeys.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label} · {shortAddr(j.account)}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="DLMM pool address"
              value={pool}
              disabled={!!source}
              onChange={(e) => edited(() => setPool(e.target.value), true)}
              placeholder="Mainnet ordinary DLMM pool"
              required
            />
            <div>
              <Field
                label="Observed owner address"
                value={owner}
                disabled={!!source}
                onChange={(e) => edited(() => setOwner(e.target.value), true)}
                placeholder="Watch-only address or connected wallet"
                required
              />
              {wallet.publicKey && !source && (
                <Btn
                  variant="ghost"
                  size="sm"
                  onClick={() => edited(() => setOwner(wallet.publicKey!.toBase58()), true)}
                >
                  Use connected wallet
                </Btn>
              )}
            </div>
            <div className="md:col-span-2 flex flex-wrap items-center gap-4">
              <Btn type="submit" disabled={!live || busy || !pool.trim() || !owner.trim()}>
                <Fingerprint size={16} /> Read pool identity
              </Btn>
              <p className="text-xs text-cream/55">
                Confirmed RPC reads. Token-2022 transfer effects are outside this v1 adapter.
              </p>
            </div>
          </form>
          {inspected && (
            <div className="mt-7 border-t border-line pt-6">
              <div className="mb-6 grid gap-4 bg-midnight p-4 sm:grid-cols-3">
                <Stat
                  label="Verified mint X"
                  value={token(inspected.scope.mintX, "X")}
                  sub={`${shortAddr(inspected.scope.mintX)} · ${inspected.scope.decimalsX} decimals`}
                />
                <Stat
                  label="Verified mint Y"
                  value={token(inspected.scope.mintY, "Y")}
                  sub={`${shortAddr(inspected.scope.mintY)} · ${inspected.scope.decimalsY} decimals`}
                />
                <Stat
                  label="Read context"
                  value={`#${inspected.slot}`}
                  sub={`Bin step ${inspected.scope.binStep} · identity read only`}
                />
              </div>
              <form onSubmit={create} className="space-y-6">
                <Field
                  label="Mission name"
                  value={label}
                  maxLength={80}
                  onChange={(e) => edited(() => setLabel(e.target.value))}
                  required
                />
                <PolicyFields
                  value={draft}
                  scope={inspected.scope}
                  onChange={(value) => edited(() => setDraft(value))}
                />
                <div className="flex flex-wrap items-center gap-4">
                  <Btn type="submit" disabled={!live || busy || !label.trim()}>
                    <ShieldCheck size={16} /> Seal policy & observe
                  </Btn>
                  <span className="text-xs text-cream/60">
                    Fresh quotes run after sealing. No capital is moved.
                  </span>
                </div>
              </form>
            </div>
          )}
        </Panel>
      )}

      {ready && missions.length === 0 && !busy && (
        <div className="grid gap-4 md:grid-cols-3">
          {[
            [
              "A target you can check",
              "Probe sizes are exact token amounts. Unknown prices never become made-up USD depth.",
            ],
            [
              "A policy you can inspect",
              "Per-operation caps, reserve, allowed actions, expiry and cooldown remain visible.",
            ],
            [
              "A record you can take away",
              "Export the journal and recompute its sampled outcomes with the shared Loco SDK.",
            ],
          ].map(([title, detail]) => (
            <Panel key={title}>
              <h3 className="display text-xl">{title}</h3>
              <p className="mt-3 text-sm leading-6 text-cream/60">{detail}</p>
            </Panel>
          ))}
        </div>
      )}

      {missions.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 border-y border-line py-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="mission-select" className="station-code mr-3 text-cream/60">
              Mission journal · {missions.length}/20
            </label>
            <select
              id="mission-select"
              value={selected}
              className="mt-2 min-h-11 max-w-full border border-line bg-navy px-3 text-sm sm:mt-0"
              onChange={(e) =>
                edited(() => {
                  setSelected(e.target.value);
                  setEditing(false);
                  setRemoving(false);
                })
              }
            >
              <option value="" disabled>
                Select a mission
              </option>
              {missions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · policy v{m.policies.at(-1)!.revision}
                </option>
              ))}
            </select>
          </div>
          <p className="station-code text-xs text-cream/50">This browser · durable journal</p>
        </div>
      )}

      {current && p && scope && (
        <>
          <section className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <Panel tone="cobalt">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="station-code text-amber">Mission health · policy v{p.revision}</p>
                  <h2 className="display mt-3 break-words text-3xl md:text-4xl">{current.label}</h2>
                  <p className="mt-3 text-sm text-cream/65">
                    {token(scope.mintX, "X")} ↔ {token(scope.mintY, "Y")} · {shortAddr(scope.pool)}{" "}
                    · bin step {scope.binStep}
                  </p>
                </div>
                <Badge state={currentState} />
              </div>
              <div className="mt-7 grid gap-5 sm:grid-cols-3">
                <Stat
                  label="Full probes"
                  value={
                    health
                      ? `${health.probes.filter((r) => r.metrics).length}/${health.probes.length}`
                      : "Awaiting read"
                  }
                  sub="Independent, not sequential swaps"
                />
                <Stat
                  label="Impact ceiling"
                  value={`${p.policy.maxImpactBps} bps`}
                  sub="Fee-exclusive average deviation"
                />
                <Stat
                  label="Read age"
                  value={
                    sample
                      ? `${Math.max(0, Math.floor((now - sample.snapshot.observedAt) / 1000))}s`
                      : "No current baseline"
                  }
                  sub={`${p.policy.maxAgeMs / 1000}s maximum · ${sample ? `slot ${sample.snapshot.slot}` : "observe this revision"}`}
                />
              </div>
              <div className="mt-7 flex flex-wrap gap-3">
                <Btn
                  disabled={!live || busy || now >= p.policy.expiresAt}
                  onClick={() => void observe(current.id)}
                >
                  <RefreshCw size={15} /> Observe now
                </Btn>
                <Btn
                  variant="line"
                  disabled={!live || busy || now >= p.policy.expiresAt}
                  onClick={() =>
                    void run("Updating visible-page monitoring…", async (job) => {
                      await job.step(
                        setMissionStatus(
                          current.id,
                          current.revision,
                          current.status === "monitoring" ? "paused" : "monitoring",
                        ),
                        4000,
                        "Monitoring state",
                      );
                      setMessage(
                        current.status === "monitoring"
                          ? "Monitoring paused. The journal is retained."
                          : "Visible-page monitoring enabled. The next observation runs within 60 seconds.",
                      );
                    })
                  }
                >
                  {current.status === "monitoring" ? <Pause size={15} /> : <Play size={15} />}
                  {current.status === "monitoring"
                    ? "Pause monitoring"
                    : "Start visible monitoring"}
                </Btn>
              </div>
              <p className="mt-4 text-xs leading-5 text-cream/55">
                Monitoring observes the selected mission every 60 seconds while this page is
                visible. Hidden tabs, failed reads and time between observations remain gaps.{" "}
                {current.status === "monitoring" && now >= p.policy.expiresAt
                  ? "This policy has expired; monitoring is inactive."
                  : "No hosted observer or automatic signing."}
              </p>
            </Panel>
            <Panel>
              <p className="station-code flex items-center gap-2 text-amber">
                <ShieldCheck size={16} /> Local policy envelope
              </p>
              <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
                <PolicyValue
                  label={`Top-up cap · ${token(scope.mintX, "X")}`}
                  value={amount(p.policy.maxDeployXRaw, scope.decimalsX)}
                />
                <PolicyValue
                  label={`Top-up cap · ${token(scope.mintY, "Y")}`}
                  value={amount(p.policy.maxDeployYRaw, scope.decimalsY)}
                />
                <PolicyValue
                  label="SOL reserve"
                  value={`${amount(p.policy.minSolReserveLamports, 9)} SOL`}
                />
                <PolicyValue
                  label="Network fee cap"
                  value={`${amount(p.policy.maxNetworkFeeLamports, 9)} SOL`}
                />
                <PolicyValue label="Swap fee ceiling" value={`${p.policy.maxSwapFeeBps} bps`} />
                <PolicyValue label="Cooldown" value={`${p.policy.cooldownMs / 60000} min`} />
              </div>
              <p className="mt-5 border-t border-line pt-4 text-xs leading-6 text-cream/65">
                Actions: {p.policy.allowedActions.join(" · ")}
                <br />
                Expires: {date(p.policy.expiresAt)}
                <br />
                Observed owner: <span title={scope.owner}>{shortAddr(scope.owner)}</span>
              </p>
              <Btn
                className="mt-4"
                variant="line"
                size="sm"
                disabled={!live || busy}
                onClick={() =>
                  edited(() => {
                    setDraft(fromPolicy(p.policy));
                    setEditing(!editing);
                  })
                }
              >
                Revise policy
              </Btn>
              <p className="mt-3 text-xs leading-5 text-cream/50">
                Unsigned local rules for preview. These caps are per operation; they are not a
                cumulative spending reservation or onchain enforcement.
              </p>
            </Panel>
          </section>
          <details className="border border-line bg-navy p-4">
            <summary className="cursor-pointer station-code text-xs text-cream/70">
              Inspect exact mission scope & read coverage
            </summary>
            <dl className="mt-4 grid gap-4 text-xs md:grid-cols-2">
              {[
                ["Pool", scope.pool],
                ["Observed owner", scope.owner],
                ["Mint X", scope.mintX],
                ["Mint Y", scope.mintY],
                ["Tracked position", scope.position ?? "Pool-only; no LP attribution"],
                ["Policy SHA-256", p.digest],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="station-code text-[0.65rem] text-cream/45">{label}</dt>
                  <dd className="mt-1 break-all font-mono leading-6 text-cream/75">{value}</dd>
                </div>
              ))}
            </dl>
            {sample && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="station-code text-[0.65rem] text-cream/45">
                  Verified quote bin arrays · context #{sample.snapshot.slot}
                </p>
                {sample.snapshot.binArrays.map((address) => (
                  <p
                    key={address}
                    className="mt-1 break-all font-mono text-xs leading-6 text-cream/60"
                  >
                    {address}
                  </p>
                ))}
                <p className="mt-3 text-xs text-cream/50">
                  Raw active-bin reference Q64: {sample.snapshot.referencePriceQ64}. Pool/bin
                  accounts share one confirmed read context; funds and position contexts remain
                  separate.
                </p>
              </div>
            )}
          </details>
          {current.lastError && (
            <Notice tone="warn" title="Latest read failed · current health is unknown">
              {current.lastError} Last successful evidence remains below with its original
              timestamp.
            </Notice>
          )}
          {editing && (
            <Panel>
              <p className="station-code text-amber">Immutable revision · v{p.revision + 1}</p>
              <h3 className="display mt-2 text-2xl">Change the rules. Keep the history.</h3>
              <p className="mb-6 mt-3 text-sm text-cream/65">
                Pool, owner, mints and position stay fixed. A new revision pauses monitoring and
                needs a fresh observation.
              </p>
              <form onSubmit={revise} className="space-y-6">
                <PolicyFields
                  value={draft}
                  scope={scope}
                  onChange={(value) => edited(() => setDraft(value))}
                />
                <div className="flex gap-3">
                  <Btn type="submit" disabled={!live || busy || current.policies.length >= 20}>
                    Seal revision {p.revision + 1}
                  </Btn>
                  <Btn variant="ghost" onClick={() => edited(() => setEditing(false))}>
                    Cancel
                  </Btn>
                </div>
              </form>
            </Panel>
          )}

          {health && sample ? (
            <>
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="station-code text-amber">02 · The depth desk</p>
                    <h3 className="display mt-2 text-3xl">Can the market do the job?</h3>
                  </div>
                  <span className="station-code border border-line px-3 py-2 text-cream/60">
                    Snapshot #{sample.snapshot.slot}
                  </span>
                </div>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-cream/65">
                  Each row is a separate exact-input SDK quote against the same frozen pool/bin
                  accounts. Price deviation compares fee-exclusive average execution with the
                  active-bin Q64 reference, rounded up to whole bps. Total trading fees include LP
                  and protocol portions.
                </p>
                <div className="mt-6 grid gap-6 xl:grid-cols-2">
                  {health.directions.map((d) => (
                    <div key={d.direction} className="min-w-0 border border-line bg-midnight p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="display text-xl">
                          {d.direction === "x-to-y"
                            ? `${token(scope.mintX, "X")} → ${token(scope.mintY, "Y")}`
                            : `${token(scope.mintY, "Y")} → ${token(scope.mintX, "X")}`}
                        </h4>
                        <span className="station-code text-xs text-cream/60">
                          {d.passing}/{d.configured} passing
                        </span>
                      </div>
                      <QuotePlot
                        probes={health.probes.filter((r) => r.quote.direction === d.direction)}
                        ceiling={p.policy.maxImpactBps}
                        decimals={d.direction === "x-to-y" ? scope.decimalsX : scope.decimalsY}
                      />
                      <p className="text-xs leading-5 text-cream/55">
                        Largest passing configured input:{" "}
                        <span className="font-mono text-cream">
                          {d.largestPassingRaw === null
                            ? "unknown / none observed"
                            : amount(
                                d.largestPassingRaw,
                                d.direction === "x-to-y" ? scope.decimalsX : scope.decimalsY,
                              )}
                        </span>
                        . This is a sampled lower bound, not maximum pool depth.
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-6 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-xs">
                    <caption className="sr-only">
                      Independent DLMM quote ladder and fee breakdown
                    </caption>
                    <thead className="station-code border-b border-line text-cream/55">
                      <tr>
                        {[
                          "Direction",
                          "Exact input",
                          "Quoted output",
                          "Total trading fee",
                          "Deviation",
                          "Result",
                        ].map((label) => (
                          <th key={label} className="px-3 py-3 font-normal">
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {health.probes.map(({ quote: q, metrics: m, state }) => {
                        const x = q.direction === "x-to-y",
                          inDecimals = x ? scope.decimalsX : scope.decimalsY,
                          outDecimals = x ? scope.decimalsY : scope.decimalsX;
                        return (
                          <tr
                            key={`${q.direction}-${q.inputRaw}`}
                            className="border-b border-line/60"
                          >
                            <td className="px-3 py-4 text-cream/65">{x ? "X → Y" : "Y → X"}</td>
                            <td className="px-3 py-4 font-mono">
                              {amount(q.inputRaw, inDecimals)}
                            </td>
                            <td className="px-3 py-4 font-mono">
                              {q.status === "quoted" ? (
                                amount(q.outputRaw, outDecimals)
                              ) : (
                                <span className="font-sans text-cream/50">Unavailable</span>
                              )}
                            </td>
                            <td className="px-3 py-4">
                              {m && q.status === "quoted" ? (
                                <>
                                  <span className="font-mono">
                                    {amount(m.totalFeeRaw, q.feeOnInput ? inDecimals : outDecimals)}{" "}
                                    {q.feeOnInput ? "in" : "out"}
                                  </span>
                                  <span className="mt-1 block text-cream/45">
                                    LP {amount(q.lpFeeRaw, q.feeOnInput ? inDecimals : outDecimals)}{" "}
                                    + protocol{" "}
                                    {amount(
                                      q.protocolFeeRaw,
                                      q.feeOnInput ? inDecimals : outDecimals,
                                    )}{" "}
                                    · {m.feeBps} bps
                                  </span>
                                </>
                              ) : (
                                "Unknown"
                              )}
                            </td>
                            <td className="px-3 py-4 font-mono">
                              {m ? `${m.impactBps} bps` : "Unknown"}
                            </td>
                            <td className={`px-3 py-4 ${tone(state)}`}>
                              {state === "met"
                                ? "Within limits"
                                : state === "unmet"
                                  ? "Exceeds limits"
                                  : "Unknown"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {health.probes.some((q) => q.quote.status === "unavailable") && (
                  <p className="mt-4 border-l-2 border-amber pl-3 text-xs leading-6 text-cream/65">
                    Unavailable sizes did not produce a full quote within two loaded bin arrays per
                    direction. The pool may have more liquidity outside this read coverage. No
                    unavailable result is counted as a passing probe or zero depth.
                  </p>
                )}
                <p className="mt-4 text-xs leading-6 text-cream/50">
                  Pool capacity includes all providers and supported native limit-order liquidity.
                  It is not attributed to your position. No transfers are simulated or sent. SDK
                  dynamic fees use the read’s wall-clock window, checked within 60 seconds of
                  Solana’s clock. Quote capacity does not guarantee a later fill.
                </p>
              </Panel>
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel>
                  <p className="station-code text-amber">03 · Inventory desk</p>
                  <h3 className="display mt-2 text-2xl">What is actually observed?</h3>
                  <div className="mt-5 grid gap-4 sm:grid-cols-3">
                    <Stat
                      label="Address SOL"
                      value={
                        sample.snapshot.funds
                          ? amount(sample.snapshot.funds.solLamports, 9)
                          : "Unknown"
                      }
                      sub={
                        sample.snapshot.funds
                          ? `Context #${sample.snapshot.funds.slot}`
                          : (sample.snapshot.fundsError ?? undefined)
                      }
                    />
                    <Stat
                      label={`ATA · ${token(scope.mintX, "X")}`}
                      value={
                        sample.snapshot.funds
                          ? amount(sample.snapshot.funds.ataXRaw, scope.decimalsX)
                          : "Unknown"
                      }
                    />
                    <Stat
                      label={`ATA · ${token(scope.mintY, "Y")}`}
                      value={
                        sample.snapshot.funds
                          ? amount(sample.snapshot.funds.ataYRaw, scope.decimalsY)
                          : "Unknown"
                      }
                    />
                  </div>
                  <p className="mt-4 text-xs leading-5 text-cream/55">
                    Canonical associated accounts only. Other token accounts and native SOL
                    converted to WSOL are not included. An observed address balance does not
                    establish signing authority.
                  </p>
                  {sample.snapshot.position ? (
                    <div className="mt-5 border-t border-line pt-5">
                      <p className="station-code text-xs text-cream/60">
                        Tracked position · {shortAddr(sample.snapshot.position.account)} · context #
                        {sample.snapshot.position.slot}
                      </p>
                      <div className="mt-4 grid grid-cols-2 gap-4">
                        <Stat
                          label={`Deployed ${token(scope.mintX, "X")}`}
                          value={amount(sample.snapshot.position.holdingsXRaw, scope.decimalsX)}
                          sub={`Unclaimed fee ${amount(sample.snapshot.position.feeXRaw, scope.decimalsX)}`}
                        />
                        <Stat
                          label={`Deployed ${token(scope.mintY, "Y")}`}
                          value={amount(sample.snapshot.position.holdingsYRaw, scope.decimalsY)}
                          sub={`Unclaimed fee ${amount(sample.snapshot.position.feeYRaw, scope.decimalsY)}`}
                        />
                      </div>
                      <p className="mt-3 text-xs text-cream/50">
                        Range {sample.snapshot.position.lower}–{sample.snapshot.position.upper}.
                        Position and owner reads are separate from the quote snapshot; they are not
                        an atomic portfolio valuation.
                      </p>
                    </div>
                  ) : (
                    <p className="mt-5 border-t border-line pt-4 text-sm leading-6 text-cream/60">
                      {scope.position
                        ? (sample.snapshot.positionError ?? "Tracked inventory unavailable.")
                        : "Pool-only mission. No owner LP contribution is inferred. Attach a position through a new Journey-scoped mission to measure its inventory."}
                    </p>
                  )}
                </Panel>
                <Panel>
                  <p className="station-code text-amber">Evidence checklist</p>
                  <h3 className="display mt-2 text-2xl">An explanation for every state.</h3>
                  <div className="mt-4 max-h-80 space-y-3 overflow-y-auto pr-2">
                    {health.checks.map((c) => (
                      <div key={c.code} className="flex gap-3 border-b border-line pb-3">
                        <span className={`mt-1.5 size-1.5 shrink-0 bg-current ${tone(c.state)}`} />
                        <div>
                          <p className={`station-code text-xs ${tone(c.state)}`}>{c.code}</p>
                          <p className="mt-1 text-xs leading-5 text-cream/65">{c.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            </>
          ) : (
            <Notice title="This policy needs its own fresh observation">
              Earlier measurements remain in the journal. Press Observe now to evaluate policy v
              {p.revision}.
            </Notice>
          )}

          <PolicyPreview
            key={`${current.id}-${p.revision}`}
            policy={p.policy}
            snapshot={sample?.snapshot ?? null}
            now={now}
          />
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="station-code text-amber">04 · Flight log</p>
                <h3 className="display mt-2 text-3xl">Sealed rules. Checkable observations.</h3>
                <p className="mt-3 text-sm text-cream/65">
                  {current.samples.length} retained observations · {current.omittedSamples} older
                  omitted · {current.policies.length}/20 policy revisions. Up to 120 observations
                  per mission.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn
                  variant="line"
                  size="sm"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(exportMission(current), null, 2)], {
                        type: "application/json",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${current.id}-evidence.json`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={14} /> Export evidence
                </Btn>
                <Btn
                  variant="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run("Repairing missing Recorder links…", async (job) => {
                      await repairConductorRecorder(current.id, job);
                      setMessage(
                        "Pending retained facts were checked and linked. Existing evidence was preserved.",
                      );
                    })
                  }
                >
                  Repair Recorder links
                </Btn>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              {current.policies.map((revision) => (
                <Link
                  key={revision.revision}
                  to="/app/recorder"
                  search={{ id: missionPolicyRecordId(current.id, revision.revision) }}
                  className="border border-line px-3 py-2 text-xs text-cream/65 hover:border-amber"
                >
                  <Fingerprint size={13} className="mr-2 inline text-amber" />
                  Policy v{revision.revision} · {revision.digest.slice(0, 12)}…{" "}
                  <span className="text-cream/40">
                    {current.recorderLinks.some(
                      (r) => r.recordId === missionPolicyRecordId(current.id, revision.revision),
                    )
                      ? "linked"
                      : "copy pending"}
                  </span>
                </Link>
              ))}
            </div>
            {current.gaps.length > 0 && (
              <details className="mt-5 border border-amber/30 p-4">
                <summary className="cursor-pointer text-sm text-amber">
                  Read-gap journal · {current.gaps.length} retained, {current.omittedGaps} older
                  omitted
                </summary>
                <div className="mt-3 max-h-48 overflow-y-auto">
                  {[...current.gaps].reverse().map((gap, i) => (
                    <p
                      key={`${gap.at}-${i}`}
                      className="border-t border-line py-2 text-xs leading-6 text-cream/60"
                    >
                      {date(gap.at)} · after observation {gap.afterSeq} · {gap.reason}
                    </p>
                  ))}
                </div>
              </details>
            )}
            <div className="mt-5 max-h-96 overflow-y-auto">
              {[...current.samples].reverse().map((s, i, rows) => {
                const policy = current.policies[s.policyRevision - 1]!;
                const h = evaluateMission(policy.policy, s.snapshot, s.recordedAt);
                const previous = rows[i + 1];
                const gap = previous && s.snapshot.startedAt - previous.snapshot.observedAt > 90000;
                return (
                  <div
                    key={s.seq}
                    className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-4"
                  >
                    <div>
                      <p className="text-sm text-cream">
                        Observation {s.seq}{" "}
                        <span className="ml-2 text-xs text-cream/45">
                          v{s.policyRevision} · #{s.snapshot.slot}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-cream/55">
                        {date(s.snapshot.observedAt)} · {h.probes.filter((r) => r.metrics).length}/
                        {h.probes.length} full quotes
                        {gap ? " · observation gap before this read" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <Badge state={h.state}>{h.state} when recorded</Badge>
                      <Link
                        to="/app/recorder"
                        search={{ id: s.recordId }}
                        className="text-xs text-amber underline underline-offset-4"
                      >
                        {current.recorderLinks.some((r) => r.recordId === s.recordId)
                          ? "Recorder ↗"
                          : "Copy pending ↗"}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-4 text-xs leading-5 text-cream/50">
              Historical states are recomputed at the recorded times. Exported observations are
              supplied evidence, not authenticated transaction receipts. SDK 0.5 validates hashes
              and recomputes the report locally; no private history is exposed over the public MCP.
            </p>
          </Panel>
          <section className="grid gap-4 md:grid-cols-3">
            <StationLink
              icon={Waypoints}
              title="Rebalance Planner"
              detail="Compare native options with fresh reads and simulation. Conductor’s preview policy is not applied to these wallet flows yet."
              to="/app/agents"
              search={
                scope.position
                  ? { inspect: scope.owner, focus: scope.position }
                  : { inspect: scope.owner }
              }
            />
            <StationLink
              icon={ArrowDownUp}
              title="Strategy Foundry"
              detail="Build a supported liquidity recipe for this pool. Review exact token effects and costs in the existing wallet flow."
              to="/app/foundry"
              search={{ pool: scope.pool }}
            />
            <StationLink
              icon={Radio}
              title="Journey & Switchyard"
              detail="Follow tracked positions and prospective range policies alongside this mission’s observed depth."
              to="/app/journey"
              search={{
                ...(scope.position
                  ? {
                      account: scope.position,
                      pool: scope.pool,
                      owner: scope.owner,
                      kind: "position" as const,
                    }
                  : {}),
              }}
            />
          </section>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
            <p className="max-w-3xl text-xs leading-5 text-cream/45">
              The Conductor v1 is a read-only mission workbench for ordinary DLMM. Hosted missions,
              cumulative reservations, execution-policy enforcement, wider-range adapters, Zap and
              DLMM Pro are separate future releases.
            </p>
            {removing ? (
              <div className="flex gap-2">
                <Btn
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run("Removing the local mission…", async (job) => {
                      await job.step(
                        removeMission(current.id, current.revision),
                        4000,
                        "Remove mission",
                      );
                      setSelected("");
                      setRemoving(false);
                      setMessage("Mission removed. Existing Flight Recorder copies remain.");
                    })
                  }
                >
                  Remove permanently
                </Btn>
                <Btn variant="ghost" size="sm" onClick={() => setRemoving(false)}>
                  Cancel
                </Btn>
              </div>
            ) : (
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
                Remove mission
              </Btn>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PolicyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="station-code text-[0.65rem] text-cream/50">{label}</p>
      <p className="mt-1 break-words font-mono text-sm text-cream">{value}</p>
    </div>
  );
}
function PolicyFields({
  value: v,
  scope,
  onChange,
}: {
  value: PolicyForm;
  scope: MissionScope;
  onChange: (value: PolicyForm) => void;
}) {
  const field = (key: Exclude<keyof PolicyForm, "actions">, label: string, hint?: string) => (
    <Field
      label={label}
      value={v[key]}
      onChange={(e) => onChange({ ...v, [key]: e.target.value })}
      hint={hint}
      required
    />
  );
  return (
    <div className="space-y-6">
      <div>
        <p className="station-code text-amber">Trade-quality objective</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {field(
            "probesX",
            `X → Y probes · ${token(scope.mintX, "X")} input`,
            "One to three increasing amounts, separated by commas. Each probe starts independently.",
          )}
          {field(
            "probesY",
            `Y → X probes · ${token(scope.mintY, "Y")} input`,
            "Token units, not USD. The two directions are not assumed equivalent in value.",
          )}
          {field(
            "impact",
            "Maximum fee-exclusive deviation · bps",
            "1 bp = 0.01%. Whole-bps ceiling; includes raw-unit rounding.",
          )}
          {field(
            "swapFee",
            "Maximum total swap fee · bps",
            "Separate from market movement; includes LP + protocol fees.",
          )}
        </div>
      </div>
      <div className="border-t border-line pt-5">
        <p className="station-code text-amber">Local policy · per-operation preview</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {field("capX", `Top-up cap · ${token(scope.mintX, "X")}`)}
          {field("capY", `Top-up cap · ${token(scope.mintY, "Y")}`)}
          {field("reserve", "Minimum SOL reserve")}
          {field("networkFee", "Maximum network fee · SOL")}
          {field(
            "cooldown",
            "Action cooldown · minutes",
            "1–1440. Complete operation evidence is required to check it.",
          )}
          {field("age", "Maximum data age · seconds", "30–150. Older measurements cannot pass.")}
          {field(
            "lifetime",
            "New policy lifetime · hours",
            "Up to 720 hours. Resealing creates a new expiry.",
          )}
        </div>
        <fieldset className="mt-5">
          <legend className="station-code mb-3 text-cream/65">Allowed action families</legend>
          <div className="flex flex-wrap gap-5">
            {MISSION_ACTIONS.map((action) => (
              <label key={action} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  className="size-4 accent-[var(--amber)]"
                  type="checkbox"
                  checked={v.actions.includes(action)}
                  onChange={(e) =>
                    onChange({
                      ...v,
                      actions: e.target.checked
                        ? [...v.actions, action]
                        : v.actions.filter((a) => a !== action),
                    })
                  }
                />
                {action}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 text-xs leading-6 text-cream/55">
          Zero token caps allow no declared token top-up. They do not cap existing deployed
          inventory. This policy is stored locally and unsigned. No transaction builder consumes it
          in v1; Planner and Foundry retain their own fresh wallet reviews.
        </p>
      </div>
    </div>
  );
}
export function QuotePlot({
  probes,
  ceiling,
  decimals,
}: {
  probes: ReturnType<typeof evaluateMission>["probes"];
  ceiling: number;
  decimals: number;
}) {
  const maximum = Math.max(1, ceiling * 1.25, ...probes.map((p) => p.metrics?.impactBps ?? 0));
  const height = 130,
    y = (value: number) => height - Math.min(height, (value / maximum) * height);
  return (
    <svg
      viewBox="0 0 420 200"
      role="img"
      aria-label="Fee-exclusive deviation for the configured independent probe sizes"
      className="my-5 w-full text-cream/55"
    >
      <line
        x1="40"
        x2="405"
        y1={y(ceiling) + 10}
        y2={y(ceiling) + 10}
        stroke="#ffc331"
        strokeDasharray="5 5"
      />
      <text x="42" y={Math.max(12, y(ceiling) + 4)} fill="#ffc331" fontSize="10">
        {ceiling} bps ceiling
      </text>
      <line x1="40" x2="405" y1="140" y2="140" stroke="currentColor" opacity="0.3" />
      {probes.map((p, i) => {
        const x = 55 + ((i + 0.5) * 335) / Math.max(1, probes.length);
        const color = p.state === "met" ? "#7be7cf" : p.state === "unmet" ? "#ffc331" : "#9cacbc";
        return (
          <g key={`${p.quote.direction}-${p.quote.inputRaw}`}>
            <title>
              {amount(p.quote.inputRaw, decimals)} input:{" "}
              {p.metrics ? `${p.metrics.impactBps} bps deviation, ${p.state}` : "unavailable"}
            </title>
            {p.metrics ? (
              <>
                <rect
                  x={x - 22}
                  y={10 + y(p.metrics.impactBps)}
                  width="44"
                  height={Math.max(2, height - y(p.metrics.impactBps))}
                  fill={color}
                  opacity="0.75"
                />
                <text
                  x={x}
                  y={Math.max(10, y(p.metrics.impactBps) + 3)}
                  textAnchor="middle"
                  fill={color}
                  fontSize="11"
                >
                  {p.metrics.impactBps} bp
                </text>
              </>
            ) : (
              <>
                <path d={`M${x - 7},112 l14,14 m-14,0 l14,-14`} stroke={color} strokeWidth="2" />
                <text x={x} y="99" textAnchor="middle" fill={color} fontSize="10">
                  Unknown
                </text>
              </>
            )}
            <text x={x} y="164" textAnchor="middle" fill="currentColor" fontSize="10">
              {amount(p.quote.inputRaw, decimals)}
            </text>
          </g>
        );
      })}
      <text x="225" y="190" textAnchor="middle" fill="currentColor" fontSize="10">
        Configured input amounts · independent quotes
      </text>
    </svg>
  );
}
function PolicyPreview({
  policy,
  snapshot,
  now,
}: {
  policy: MissionPolicy;
  snapshot: MissionSnapshot | null;
  now: number;
}) {
  const [action, setAction] = useState<(typeof MISSION_ACTIONS)[number]>("rebalance"),
    [x, setX] = useState("0"),
    [y, setY] = useState("0");
  let report: ReturnType<typeof previewMissionAction> | null = null,
    error = "";
  try {
    if (snapshot)
      report = previewMissionAction(
        policy,
        snapshot,
        {
          scope: policy.scope,
          action,
          spendXRaw: raw(x, policy.scope.decimalsX),
          spendYRaw: raw(y, policy.scope.decimalsY),
          networkFeeLamports: null,
          rentLamports: null,
          nativeSolSpendLamports: null,
          lastConfirmedActionAt: null,
          cooldownEvidenceComplete: false,
        },
        now,
      );
  } catch (e) {
    error = err(e);
  }
  return (
    <Panel>
      <p className="station-code text-amber">Policy feasibility preview</p>
      <h3 className="display mt-2 text-2xl">Does a declared action fit the envelope?</h3>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-cream/65">
        Check action families and exact top-up ceilings. Native costs, recent-operation completeness
        and execution checks stay unknown until a supported build supplies them. This preview never
        enables a signature.
      </p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="mission-preview-action" className="station-code text-cream/70">
            Declared action
          </label>
          <select
            id="mission-preview-action"
            className="mt-2 min-h-11 w-full border border-line bg-midnight px-3 text-sm"
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
          >
            {MISSION_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <Field
          label={`Declared top-up · ${token(policy.scope.mintX, "X")}`}
          value={x}
          onChange={(e) => setX(e.target.value)}
        />
        <Field
          label={`Declared top-up · ${token(policy.scope.mintY, "Y")}`}
          value={y}
          onChange={(e) => setY(e.target.value)}
        />
      </div>
      <div className="mt-5 border border-line bg-midnight p-4">
        <p
          className={`station-code ${report?.state === "blocked" ? "text-amber" : "text-cream/65"}`}
        >
          {error
            ? "Invalid amount"
            : report?.state === "blocked"
              ? "Blocked by declared policy"
              : "Needs fresh execution evidence"}
        </p>
        {error && <p className="mt-2 text-sm text-cream/65">{error}</p>}
        {report &&
          [...report.blocked, ...report.unknown].map((reason) => (
            <p key={reason} className="mt-2 flex gap-2 text-sm text-cream/65">
              <span aria-hidden>·</span>
              {reason}
            </p>
          ))}
        {!snapshot && (
          <p className="mt-2 text-sm text-cream/60">
            Observe this policy revision before previewing an action.
          </p>
        )}
        <p className="mt-3 text-xs leading-5 text-cream/45">
          This is arithmetic against supplied declarations, not instruction verification, native
          simulation, cumulative budgeting or execution authority. The market-health objective and a
          proposed action’s funding are separate checks.
        </p>
      </div>
    </Panel>
  );
}
function StationLink({
  icon: Icon,
  title,
  detail,
  to,
  search,
}: {
  icon: typeof Gauge;
  title: string;
  detail: string;
  to: "/app/agents" | "/app/foundry" | "/app/journey";
  search: Record<string, string>;
}) {
  return (
    <Link
      to={to}
      search={search}
      className="group border border-line bg-navy p-5 transition-colors hover:border-amber"
    >
      <Icon className="text-amber" size={22} />
      <h3 className="display mt-4 flex items-center justify-between text-xl">
        {title}
        <ArrowRight
          size={16}
          className="text-amber transition-transform group-hover:translate-x-1"
        />
      </h3>
      <p className="mt-3 text-xs leading-6 text-cream/60">{detail}</p>
    </Link>
  );
}

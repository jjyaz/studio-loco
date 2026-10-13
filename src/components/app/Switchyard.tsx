import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useConnection } from "@solana/wallet-adapter-react";
import { ArrowRight, Download, GitBranch, Pause, Play, RefreshCw, TrainFront } from "lucide-react";
import { Btn, Field, Notice, Panel, Segmented, Spinner, Stat, btn } from "@/components/kit";
import { useSettings } from "@/lib/settings";
import { JobCancelled, JobControl, type Job } from "@/lib/job-control";
import { listJourneys, subscribeJourney, saveJourney } from "@/lib/journey-store";
import { appendSnapshot, type Journey } from "@/lib/journey";
import { readJourneySnapshot } from "@/lib/journey-chain";
import { journeyError } from "@/lib/journey-capture";
import { listStrategies } from "@/lib/continuity-store";
import { listRecords, subscribeRecorder } from "@/lib/recorder-store";
import type { FlightRecord } from "@/lib/recorder";
import {
  listShadowExperiments,
  subscribeSwitchyard,
  saveShadowExperiment,
  setShadowStatus,
  removeShadowExperiment,
} from "@/lib/switchyard-store";
import {
  createShadowExperiment,
  parseSwitchyardImport,
  exportSwitchyard,
  shadowScorecards,
  retainedDecisions,
  promotionRefusal,
  SHADOW_LABEL,
  ShadowPolicy,
  SWITCHYARD_MAX_BYTES,
  type ShadowExperiment,
  type ShadowTrack,
} from "@/lib/switchyard";
import { observeShadowExperiment, repairShadowRecorder } from "@/lib/switchyard-chain";
import { solTextToLamports } from "@/lib/planner";
import { formatUnits } from "@/lib/amount";
import { shortAddr } from "@/lib/format";
import hero from "@/assets/studio-loco-night-station.png.asset.json";

const date = (at: number) => new Date(at).toLocaleString();
const colors = { actual: "#a5b9ff", stay: "#9cacbc", recenter: "#ffc331", widen: "#7be7cf" };
type PlotTrack = "actual" | ShadowTrack;
export function Switchyard({
  initial = {},
}: {
  initial?: { experiment?: string; journey?: string };
}) {
  const { settings, hydrated } = useSettings();
  const { connection } = useConnection();
  const live = hydrated && !settings.practice && settings.cluster === "mainnet-beta";
  const source = settings.rpc["mainnet-beta"] ? ("custom" as const) : ("relay" as const);
  const [rows, setRows] = useState<ShadowExperiment[]>([]);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [records, setRecords] = useState<FlightRecord[]>([]);
  const [selected, setSelected] = useState(initial.experiment ?? "");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [sourceId, setSourceId] = useState(initial.journey ?? "");
  const [label, setLabel] = useState("My live range comparison");
  const [edge, setEdge] = useState("3");
  const [cooldown, setCooldown] = useState("5");
  const [widenBy, setWidenBy] = useState("20");
  const [cap, setCap] = useState("69");
  const [fee, setFee] = useState("");
  const [plot, setPlot] = useState<PlotTrack>("recenter");
  const [now, setNow] = useState(() => Date.now());
  const ctl = useRef(new JobControl());
  const mounted = useRef(false),
    reloadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  const current = rows.find((e) => e.id === selected) ?? rows[0];
  const currentId = current?.id,
    currentStatus = current?.status,
    provenance = current?.provenance;
  useEffect(() => {
    mounted.current = true;
    ctl.current.mounted = true;
    const off = ctl.current.subscribe(() => {
      if (mounted.current) setBusy(ctl.current.busy);
    });
    const a = subscribeSwitchyard(() => void reload());
    const b = subscribeJourney(() => void reload());
    const c = subscribeRecorder(() => void reload());
    void reload();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      reloadVersion.current++;
      ctl.current.unmount();
      off();
      a();
      b();
      c();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    ctl.current.invalidate();
    setRemoving(false);
  }, [connection, live, source]);
  useEffect(() => {
    // The first store notification can expose a newly saved row while its
    // creation job is still preserving the source Journey. That row belongs
    // to this job; selecting it must not cancel its own setup.
    if (!creating) ctl.current.invalidate();
    setRemoving(false);
  }, [currentId]);
  useEffect(() => {
    if (
      !currentId ||
      !live ||
      creating ||
      currentStatus !== "running" ||
      provenance !== "this-device"
    )
      return;
    const read = () => {
      if (document.visibilityState === "visible") void observe(currentId);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") ctl.current.invalidate();
      else read();
    };
    read();
    const timer = setInterval(read, 60_000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      ctl.current.invalidate();
    };
  }, [currentId, currentStatus, provenance, live, creating, connection, source]);
  async function reload() {
    const version = ++reloadVersion.current;
    const result = await Promise.allSettled([
      listShadowExperiments(),
      listJourneys(),
      listRecords(),
    ]);
    if (!mounted.current || version !== reloadVersion.current) return;
    const [a, b, c] = result;
    if (a.status === "fulfilled") setRows(a.value);
    if (b.status === "fulfilled") setJourneys(b.value.filter((j) => j.kind === "position"));
    if (c.status === "fulfilled") setRecords(c.value);
    setStorageError(
      result
        .filter((r) => r.status === "rejected")
        .map((r) => journeyError((r as PromiseRejectedResult).reason))
        .join(" "),
    );
    setReady(true);
  }
  function edited(fn: () => void) {
    ctl.current.invalidate();
    setError("");
    fn();
  }
  async function run(message: string, work: (job: Job) => Promise<void>) {
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setStatus(message);
    try {
      await work(job);
      job.check();
      await reload();
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        setError(journeyError(e));
        setStatus("");
      }
    } finally {
      ctl.current.end(job);
    }
  }
  async function start(event: FormEvent) {
    event.preventDefault();
    if (!live) return;
    await run("Checking source account and saving the sealed policy…", async (job) => {
      const j = journeys.find((j) => j.id === sourceId);
      if (!j) throw new Error("Choose a tracked LP position in Journey first.");
      const assumed = fee.trim() ? solTextToLamports(fee) : null;
      if (fee.trim() && assumed === null)
        throw new Error("Enter a valid SOL fee assumption or leave it blank.");
      const policy = ShadowPolicy.parse({
        version: 1,
        edgeBins: Number(edge),
        cooldownMs: Number(cooldown) * 60_000,
        widenByBins: Number(widenBy),
        maxWidthBins: Number(cap),
        assumedFeeLamports: assumed?.toString() ?? null,
      });
      const identity = {
        kind: "position" as const,
        account: j.account,
        pool: j.pool,
        owner: j.owner,
      };
      const snapshot = await readJourneySnapshot(
        connection,
        identity,
        job,
        source,
        j.snapshots.at(-1),
      );
      const strategies = await job.step(listStrategies(), 4000, "Journey Continuity association");
      const associated = strategies
        .filter(
          (s) =>
            s.provenance !== "import" &&
            s.accounts.some(
              (a) =>
                a.kind === "position" &&
                a.account === j.account &&
                a.pool === j.pool &&
                a.owner === j.owner,
            ),
        )
        .sort(
          (a, b) => Number(b.provenance === "verified") - Number(a.provenance === "verified"),
        )[0];
      const candidate = createShadowExperiment({
        identity,
        snapshot,
        label,
        policy,
        continuityId: associated?.id,
      });
      job.check();
      const saved = await job.step(saveShadowExperiment(candidate), 4000, "Sealed experiment");
      // Preserve a concurrently newer Journey. The experiment still retains its verified seed.
      try {
        await job.step(saveJourney(appendSnapshot(j, snapshot), j), 4000, "Source observation");
      } catch (e) {
        if (e instanceof JobCancelled) throw e;
      }
      setSelected(saved.id);
      setCreating(false);
      setStatus(
        "Experiment saved. Each later read is scored before its hypothetical policy decision.",
      );
    });
  }
  async function observe(id: string) {
    if (!live || creating) return;
    await run("Reading and comparing the current account observation…", async (job) => {
      const saved = await observeShadowExperiment({ connection, id, job, source });
      job.check();
      if (saved)
        setStatus(
          "Observed " +
            date(saved.samples.at(-1)!.observedAt) +
            " · slot " +
            saved.samples.at(-1)!.slot +
            ". Hypothetical actions remain unsigned.",
        );
    });
  }
  async function toggle(e: ShadowExperiment) {
    ctl.current.invalidate();
    try {
      await setShadowStatus(e.id, e.status === "running" ? "paused" : "running");
      setStatus(
        e.status === "running"
          ? "Experiment paused. Its history is retained."
          : "Resumed. The next observation resets the gap baseline before further proposals.",
      );
      setError("");
      await reload();
    } catch (error) {
      setError(journeyError(error));
    }
  }
  function download(e: ShadowExperiment) {
    try {
      const text = JSON.stringify(exportSwitchyard([e]), null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "studio-loco-switchyard-" + Date.now() + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(
        "Experiment exported as supplied evidence. It contains no executable transaction inputs.",
      );
    } catch (e) {
      setError(journeyError(e));
    }
  }
  async function importFile(file?: File) {
    if (!file || busy) return;
    try {
      if (file.size > SWITCHYARD_MAX_BYTES) throw new Error("Switchyard bundle exceeds 10 MB.");
      const imported = parseSwitchyardImport(await file.text());
      const existing = await listShadowExperiments();
      if (existing.length + imported.length > 20)
        throw new Error("Import would exceed the 20-experiment device limit.");
      for (const e of imported) await saveShadowExperiment(e);
      setSelected(imported[0]!.id);
      setError("");
      setStatus(
        imported.length +
          " supplied experiment(s) imported. Live monitoring and promotion remain disabled.",
      );
      await reload();
    } catch (e) {
      setError(journeyError(e));
    }
  }
  const last = current?.samples.at(-1) ?? current?.seed;
  const stale = last && (now < last.observedAt || now - last.observedAt > 150_000);
  const decisions = current ? retainedDecisions(current) : [];
  const pending = current
    ? decisions.filter((d) => !current.recorderLinks.some((l) => l.recordId === d.recordId))
    : [];
  return (
    <div className="space-y-6">
      <section
        aria-label="The Switchyard introduction"
        className="grid overflow-hidden border border-amber/35 bg-[#101e3b] lg:grid-cols-[1.1fr_1fr]"
      >
        <div className="p-6 md:p-9">
          <p className="station-code flex items-center gap-2 text-amber">
            <GitBranch size={16} /> ST-14 · THE SWITCHYARD
          </p>
          <h1 className="display mt-5 text-4xl leading-tight md:text-6xl">
            One journey.
            <br />
            More ways forward.
          </h1>
          <p className="mt-5 max-w-xl text-cream/75">
            Follow a real LP account beside three hypothetical range policies. Record each decision,
            then see what later observations reveal.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Btn
              onClick={() => {
                ctl.current.invalidate();
                setCreating((v) => !v);
              }}
              disabled={!ready || busy}
            >
              <TrainFront size={16} /> New comparison
            </Btn>
            <Link to="/app/journey" className={btn({ variant: "line" })}>
              Open Journey <ArrowRight size={16} />
            </Link>
          </div>
          <p className="station-code mt-6 text-xs text-amber">
            LIVE ACCOUNT READS · HYPOTHETICAL POLICIES · DEVICE HISTORY
          </p>
        </div>
        <div className="relative min-h-60 border-t border-line lg:border-l lg:border-t-0">
          <img
            src={hero.url}
            alt="The Studio Loco train arriving at a glowing station in a golden landscape"
            className="absolute h-full w-full object-cover"
          />
          <p className="station-code absolute inset-x-5 bottom-5 border border-cream/40 bg-midnight/80 p-3 text-xs">
            JOURNEY → SHADOW TRACKS → RECORDER → FRESH REVIEW
          </p>
        </div>
      </section>
      {!live && (
        <Notice tone="warn" title="Mainnet live mode required">
          Turn off Practice and choose mainnet in Settings to start observations. Retained and
          imported history remains readable.
        </Notice>
      )}
      {storageError && (
        <Notice tone="error" title="Device evidence unavailable">
          {storageError}
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Comparison incomplete">
          {error}
        </Notice>
      )}
      {status && (
        <p role="status" className="text-sm text-cream/75">
          {status}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <p className="station-code text-cream/60">
          {storageError && !rows.length
            ? "DEVICE HISTORY UNAVAILABLE"
            : rows.length + " SAVED EXPERIMENT(S) · MAX 20"}
        </p>
        <label className={btn({ variant: "quiet", size: "sm" })}>
          Import supplied evidence
          <input
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label="Import Switchyard evidence"
            disabled={busy}
            onChange={(e) => {
              void importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {creating && (
        <Panel>
          <h2 className="display text-2xl">Lay a new track.</h2>
          <p className="mt-2 text-sm text-cream/70">
            A fresh verified read starts this experiment. Its source and policy are sealed; future
            policy changes begin a new experiment.
          </p>
          <form onSubmit={start} className="mt-6 space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Experiment name"
                value={label}
                maxLength={80}
                required
                onChange={(e) => edited(() => setLabel(e.target.value))}
              />
              <div>
                <label
                  className="station-code mb-2 block text-cream/80"
                  htmlFor="switchyard-source"
                >
                  Tracked LP position
                </label>
                <select
                  id="switchyard-source"
                  className="min-h-11 w-full border border-line bg-midnight px-3 font-mono text-sm"
                  value={sourceId}
                  onChange={(e) => edited(() => setSourceId(e.target.value))}
                >
                  <option value="">Choose a source Journey</option>
                  {journeys.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.label} · {shortAddr(j.account)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!journeys.length && (
              <p className="text-sm text-amber">
                Track a public LP account in Journey first. A wallet connection is not needed for
                observation.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="Edge trigger"
                value={edge}
                type="number"
                min="0"
                max="20"
                step="1"
                suffix="bins"
                onChange={(e) => edited(() => setEdge(e.target.value))}
              />
              <Field
                label="Action cooldown"
                value={cooldown}
                type="number"
                min="1"
                max="1440"
                step="1"
                suffix="min"
                onChange={(e) => edited(() => setCooldown(e.target.value))}
              />
              <Field
                label="Widening step"
                value={widenBy}
                type="number"
                min="1"
                max="34"
                step="1"
                suffix="bins"
                onChange={(e) => edited(() => setWidenBy(e.target.value))}
              />
              <Field
                label="Maximum shadow width"
                value={cap}
                type="number"
                min="1"
                max="69"
                step="1"
                suffix="bins"
                onChange={(e) => edited(() => setCap(e.target.value))}
              />
            </div>
            <Field
              label="Assumed fee per proposal"
              value={fee}
              suffix="SOL"
              inputMode="decimal"
              placeholder="Optional · leave unpriced"
              onChange={(e) => edited(() => setFee(e.target.value))}
              hint="Your explicit network-fee budget assumption. It excludes rent and token costs; it is not actual spending or an SDK transaction quote."
            />
            <p className="text-xs text-cream/60">
              Stay preserves the initial range. Recenter preserves its width. Widen must include the
              prior range and current active bin, within the chosen cap. Seed positions support at
              most 69 bins.
            </p>
            <Btn
              type="submit"
              disabled={!live || !sourceId || !label.trim() || busy || !!storageError}
            >
              {busy ? <Spinner /> : <GitBranch size={16} />} Start live comparison
            </Btn>
          </form>
        </Panel>
      )}
      {!ready && (
        <p className="flex items-center gap-2 text-cream/70">
          <Spinner /> Reading device history…
        </p>
      )}
      {ready && !rows.length && !storageError && !creating && (
        <Panel tone="cobalt">
          <h2 className="display text-3xl">The next decision deserves context.</h2>
          <p className="mt-3 max-w-3xl text-cream/70">
            Choose a tracked LP position, seal its range rules, and let future verified reads score
            the alternatives. The first read is a baseline. No earlier market history is
            reconstructed.
          </p>
        </Panel>
      )}
      {current && (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[240px_minmax(0,1fr)]">
          <aside aria-label="Switchyard experiments" className="space-y-2">
            {rows.map((e) => (
              <button
                key={e.id}
                type="button"
                aria-pressed={e.id === current.id}
                className={
                  "w-full border p-4 text-left " +
                  (e.id === current.id ? "border-amber bg-amber/10" : "border-line bg-[#101e3b]")
                }
                onClick={() => {
                  ctl.current.invalidate();
                  setSelected(e.id);
                  setError("");
                  setStatus("");
                  setCreating(false);
                }}
              >
                <span className="block text-sm font-medium">{e.label}</span>
                <span className="station-code mt-2 block text-[0.65rem] text-cream/60">
                  {e.provenance === "import" ? "SUPPLIED · READ-ONLY" : e.status.toUpperCase()} ·{" "}
                  {e.samples.length} READS
                </span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 space-y-5">
            <Panel tone="cobalt">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="station-code text-xs text-amber">
                    {current.provenance === "import"
                      ? "SUPPLIED EVIDENCE · NOT RECHECKED"
                      : current.lastError
                        ? "OBSERVATION UNAVAILABLE"
                        : stale
                          ? "HISTORICAL · REFRESH REQUIRED"
                          : "VERIFIED ACCOUNT READ · HYPOTHETICAL POLICIES"}
                  </p>
                  <h2 className="display mt-3 text-3xl">{current.label}</h2>
                  <p className="mt-2 break-all font-mono text-xs text-cream/55">{current.id}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {current.provenance === "this-device" && (
                    <>
                      <Btn
                        size="sm"
                        variant="line"
                        onClick={() => void toggle(current)}
                        disabled={!live && current.status === "paused"}
                      >
                        {current.status === "running" ? <Pause size={14} /> : <Play size={14} />}
                        {current.status === "running" ? "Pause experiment" : "Resume experiment"}
                      </Btn>
                      <Btn
                        size="sm"
                        variant="quiet"
                        disabled={!live || busy || current.status !== "running"}
                        onClick={() => void observe(current.id)}
                      >
                        <RefreshCw size={14} /> Observe now
                      </Btn>
                    </>
                  )}
                  <Btn size="sm" variant="quiet" onClick={() => download(current)}>
                    <Download size={14} /> Export experiment
                  </Btn>
                </div>
              </div>
              <div className="mt-6 grid gap-5 sm:grid-cols-3">
                <Stat
                  label="Retained observations"
                  value={current.samples.length}
                  sub="Seed baseline excluded"
                />
                <Stat
                  label="Hypothetical proposals"
                  value={decisions.length}
                  sub="No transactions sent"
                />
                <Stat
                  label="Observed gaps"
                  value={current.samples.filter((s) => s.gapReason !== "none").length}
                  sub="Intervals remain unknown"
                />
              </div>
              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-cream/70">
                <span>Position {shortAddr(current.source.account)}</span>
                <span>Pool {shortAddr(current.source.pool)}</span>
                <span>Owner {shortAddr(current.source.owner)}</span>
                {current.provenance === "this-device" && (
                  <Link
                    to="/app/journey"
                    search={{
                      account: current.source.account,
                      pool: current.source.pool,
                      owner: current.source.owner,
                      kind: "position",
                      continuity: current.continuityId ?? undefined,
                    }}
                    className="text-amber underline"
                  >
                    {current.continuityId
                      ? "Open linked Journey Continuity"
                      : "Open source Journey"}
                  </Link>
                )}
              </div>
              {last && (
                <p className="mt-3 text-xs leading-5 text-cream/60">
                  Last input {date(last.observedAt)} · identity slot {last.slot} → account
                  corroboration {last.checkedSlot}. The account and pool are read separately; this
                  is not an atomic market snapshot.
                </p>
              )}
            </Panel>
            {current.lastError && (
              <Notice tone="error" title="Source observation unavailable">
                {current.lastError} Prior evidence is retained; no replacement market data is
                generated.
              </Notice>
            )}
            {current.provenance === "import" && (
              <Notice tone="warn" title="Supplied history">
                This file's source, timestamps and Recorder references have not been authenticated.
                It cannot be monitored, promoted or linked into local wallet actions.
              </Notice>
            )}
            <section
              aria-label="Range policy scorecards"
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            >
              {shadowScorecards(current).map((s) => (
                <Panel key={s.track} className="min-w-0">
                  <p className="station-code text-xs" style={{ color: colors[s.track] }}>
                    {SHADOW_LABEL[s.track]}
                  </p>
                  <p className="display mt-4 text-4xl">
                    {s.coveragePct === null ? "—" : s.coveragePct.toFixed(1) + "%"}
                  </p>
                  <p className="mt-1 text-xs text-cream/60">Observed range coverage</p>
                  <dl className="mt-4 space-y-3 text-sm">
                    <div>
                      <dt className="text-cream/55">Samples in range</dt>
                      <dd className="font-mono">
                        {s.inRange} / {s.samples}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-cream/55">Last edge distance</dt>
                      <dd>
                        {s.lastEdgeDistance === null
                          ? "No scored input"
                          : s.lastEdgeDistance < 0
                            ? "Outside by " + Math.abs(s.lastEdgeDistance) + " bins"
                            : s.lastEdgeDistance + " bins inside"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-cream/55">Policy proposals</dt>
                      <dd>
                        {s.proposals === null ? "Not inferred from account reads" : s.proposals}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-cream/55">Assumed proposal fees</dt>
                      <dd className="break-all">
                        {s.assumedProposalFeesLamports === null
                          ? "Unpriced"
                          : formatUnits(s.assumedProposalFeesLamports, 9, 9) + " SOL"}
                      </dd>
                    </div>
                  </dl>
                </Panel>
              ))}
            </section>
            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h3 className="display text-2xl">The tracks, as observed.</h3>
                <Segmented
                  label="Chart range policy"
                  value={plot}
                  onChange={setPlot}
                  options={(["actual", "stay", "recenter", "widen"] as const).map((value) => ({
                    value,
                    label: SHADOW_LABEL[value],
                  }))}
                />
              </div>
              <SwitchyardPlot experiment={current} track={plot} />
              <p className="mt-3 text-xs text-cream/60">
                Vertical bars show the range before each decision; dots mark observed active bins.
                Latest 90 inputs shown. Gaps are marked and never interpolated.
              </p>
            </Panel>
            <Panel>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="display text-2xl">Decisions before outcomes.</h3>
                {current.provenance === "this-device" && pending.length > 0 && (
                  <Btn
                    size="sm"
                    variant="line"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        "Copying retained decision evidence to Flight Recorder…",
                        async (job) => {
                          const count = await repairShadowRecorder(current.id, job);
                          setStatus(count + " Recorder link(s) repaired.");
                        },
                      )
                    }
                  >
                    Repair {pending.length} Recorder link(s)
                  </Btn>
                )}
              </div>
              {current.recorderError && (
                <p className="mt-3 text-sm text-amber">{current.recorderError}</p>
              )}
              {!decisions.length && (
                <p className="mt-4 text-sm text-cream/65">
                  No policy action has been proposed in the retained window. Observations and
                  non-action reasons remain in the export.
                </p>
              )}
              <ol className="mt-5 space-y-3">
                {[...decisions]
                  .reverse()
                  .slice(0, 12)
                  .map((d) => {
                    const refusal = promotionRefusal(current, d, now);
                    const record =
                      current.provenance === "this-device" &&
                      records.find(
                        (r) =>
                          r.id === d.recordId &&
                          r.provenance === "this-device" &&
                          r.context["experimentId"] === current.id &&
                          r.context["decisionId"] === d.id,
                      );
                    return (
                      <li key={d.id} className="border border-line bg-midnight/50 p-4">
                        <div className="flex flex-wrap justify-between gap-3">
                          <div>
                            <p className="station-code text-xs text-amber">
                              HYPOTHETICAL · {d.track.toUpperCase()} · POLICY V{d.policyVersion}
                            </p>
                            <p className="mt-2 text-sm">
                              {d.inputRange.lower} → {d.inputRange.upper}{" "}
                              <span className="mx-2 text-amber">→</span> {d.target.lower} →{" "}
                              {d.target.upper}
                            </p>
                            <p className="mt-1 text-xs text-cream/60">
                              {d.trigger} · active {d.activeId} · recorded {date(d.recordedAt)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            {record ? (
                              <Link
                                to="/app/recorder"
                                search={{ id: d.recordId }}
                                className="text-sm text-amber underline"
                              >
                                Decision evidence
                              </Link>
                            ) : (
                              <span className="text-xs text-cream/50">
                                {current.provenance === "import"
                                  ? "Supplied Recorder reference"
                                  : "Recorder copy unavailable"}
                              </span>
                            )}
                            {!refusal && (
                              <Link
                                to="/app/agents"
                                search={{
                                  inspect: current.source.owner,
                                  focus: current.source.account,
                                  shadow: current.id,
                                  decision: d.id,
                                }}
                                className={btn({ variant: "line", size: "sm" })}
                              >
                                Compare in Planner <ArrowRight size={14} />
                              </Link>
                            )}
                          </div>
                        </div>
                        {refusal && <p className="mt-3 text-xs text-cream/55">{refusal}</p>}
                      </li>
                    );
                  })}
              </ol>
              {decisions.length > 12 && (
                <p className="mt-3 text-xs text-cream/55">
                  Newest 12 decisions shown; the export preserves every retained decision.
                </p>
              )}
            </Panel>
            <details className="border border-line bg-[#101e3b] p-5">
              <summary className="cursor-pointer font-medium text-cream">
                Sealed policy & comparison methodology
              </summary>
              <div className="mt-4 space-y-3 text-sm leading-6 text-cream/70">
                <p>
                  Policy v1 · edge {current.policy.edgeBins} bins · cooldown{" "}
                  {current.policy.cooldownMs / 60_000} min · widen by {current.policy.widenByBins}{" "}
                  bins · cap {current.policy.maxWidthBins} bins.
                </p>
                <p>
                  Coverage is a fraction of retained observed samples, not time in range. Each
                  sample is scored against the prior virtual range. A hypothetical action takes
                  effect after its decision is recorded, with immediate settlement assumed.
                </p>
                <p>
                  Balances, token conversions, swap effects, execution latency, slippage, earned
                  fees and PnL are not modeled. Assumed proposal fees use your sealed network-fee
                  input and exclude rent; they are not actual spending or a transaction quote.
                  Planner supplies fresh native simulations and costs before wallet review.
                </p>
                <p>
                  Only this visible page observes, once per minute. Closing it, pausing or read
                  failures create gaps. The first read after a gap suppresses actions and
                  establishes a new observation baseline. No missed market path is reconstructed.
                </p>
                <p>
                  Source association with Journey Continuity is device evidence. It does not trace
                  fungible capital or authenticate an imported history.
                </p>
                <p>
                  Latest 360 scored observations retained. Earlier inputs omitted:{" "}
                  {current.omittedSamples}. Scorecards and fee budgets cover this retained window.
                </p>
              </div>
            </details>
            {current.provenance === "this-device" && (
              <Link
                to="/app/agents"
                search={{ inspect: current.source.owner, focus: current.source.account }}
                className="inline-flex items-center gap-2 text-sm text-amber underline"
              >
                Open a fresh account comparison <ArrowRight size={14} />
              </Link>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving((v) => !v)}>
                Remove experiment
              </Btn>
              {removing && (
                <>
                  <span className="text-xs text-cream/60">
                    Export first. This removes only this device's experiment.
                  </span>
                  <Btn
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      ctl.current.invalidate();
                      try {
                        await removeShadowExperiment(current);
                        setSelected("");
                        setRemoving(false);
                        await reload();
                      } catch (e) {
                        setError(journeyError(e));
                      }
                    }}
                  >
                    Confirm removal
                  </Btn>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Point observations only. No interpolation or fabricated continuous price/range history. */
export function SwitchyardPlot({
  experiment,
  track,
}: {
  experiment: ShadowExperiment;
  track: PlotTrack;
}) {
  const sample = experiment.samples.slice(-90);
  const points = sample.length
    ? sample.map((s) => ({
        at: s.observedAt,
        active: s.activeId,
        range: track === "actual" ? s.actualRange : s.tracks.find((r) => r.track === track)!.before,
        gap: s.gapReason !== "none",
      }))
    : [
        {
          at: experiment.seed.observedAt,
          active: experiment.seed.activeId,
          range: experiment.seed.actualRange,
          gap: false,
        },
      ];
  const low = Math.min(...points.flatMap((p) => [p.active, p.range.lower]));
  const high = Math.max(...points.flatMap((p) => [p.active, p.range.upper]));
  const pad = Math.max(2, Math.ceil((high - low) * 0.08));
  const bottom = low - pad,
    top = high + pad,
    y = (n: number) => 270 - ((n - bottom) / (top - bottom)) * 235;
  const from = points[0]!.at,
    to = points.at(-1)!.at;
  const x = (at: number) =>
    points.length === 1 ? 540 : 95 + ((at - from) / Math.max(1, to - from)) * 875;
  return (
    <div className="mt-5 min-w-0">
      <svg
        viewBox="0 0 1020 335"
        role="img"
        aria-label={
          SHADOW_LABEL[track] +
          " observed ranges and active bins; " +
          points.length +
          " point observations"
        }
        className="h-auto w-full"
      >
        {[0, 1, 2, 3].map((i) => {
          const value = Math.round(bottom + ((top - bottom) * i) / 3);
          return (
            <g key={i}>
              <line
                x1="90"
                x2="980"
                y1={y(value)}
                y2={y(value)}
                stroke="#2c4264"
                strokeDasharray="4 7"
              />
              <text x="8" y={y(value) + 4} fill="#9cacbc" fontSize="15" fontFamily="monospace">
                {value}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => (
          <g key={i}>
            {p.gap && (
              <>
                <line
                  x1={x(p.at)}
                  x2={x(p.at)}
                  y1="16"
                  y2="285"
                  stroke="#ffc331"
                  strokeDasharray="3 7"
                  opacity=".55"
                />
                <text x={x(p.at)} y="14" textAnchor="middle" fontSize="12" fill="#ffc331">
                  gap
                </text>
              </>
            )}
            <line
              x1={x(p.at)}
              x2={x(p.at)}
              y1={y(p.range.lower)}
              y2={y(p.range.upper)}
              stroke={colors[track]}
              strokeWidth={Math.max(2, Math.min(10, 360 / points.length))}
              opacity=".48"
            />
            <circle
              cx={x(p.at)}
              cy={y(p.active)}
              r={points.length > 40 ? 3 : 5}
              fill={p.active >= p.range.lower && p.active <= p.range.upper ? "#fff3c9" : "#ff9865"}
            >
              <title>
                {date(p.at) +
                  " · active " +
                  p.active +
                  " · prior range " +
                  p.range.lower +
                  ".." +
                  p.range.upper +
                  (p.gap ? " · observation gap" : "")}
              </title>
            </circle>
          </g>
        ))}
        <text x="92" y="316" fill="#9cacbc" fontSize="14" fontFamily="monospace">
          {sample.length ? date(from) : "Seed baseline · no scored samples"}
        </text>
        {points.length > 1 && (
          <text
            x="980"
            y="316"
            fill="#9cacbc"
            fontSize="14"
            fontFamily="monospace"
            textAnchor="end"
          >
            {date(to)}
          </text>
        )}
      </svg>
    </div>
  );
}

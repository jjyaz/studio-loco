import { createFileRoute, Link } from "@tanstack/react-router";
import { useConnection } from "@solana/wallet-adapter-react";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowRight,
  Bell,
  Check,
  Download,
  Fingerprint,
  MapPin,
  Radio,
  RefreshCw,
  Waypoints,
} from "lucide-react";
import { Btn, Field, Notice, Panel, Segmented, Spinner, Stat, btn } from "@/components/kit";
import { useSettings } from "@/lib/settings";
import { formatUnits } from "@/lib/amount";
import { shortAddr, explorerTx } from "@/lib/format";
import { JobControl, JobCancelled } from "@/lib/job-control";
import { listRecords, recordFact, subscribeRecorder } from "@/lib/recorder-store";
import { listBlueprints, subscribeFoundry, type SavedBlueprint } from "@/lib/foundry-store";
import { listJourneys, saveJourney, removeJourney, subscribeJourney } from "@/lib/journey-store";
import {
  JOURNEY_POLL_MS,
  JOURNEY_STALE_MS,
  JourneyIdentity,
  appendSnapshot,
  foundryCandidate,
  journeyId,
  newJourney,
  rangeHealth,
  snapshotHealth,
  type Journey,
  type JourneySnapshot,
} from "@/lib/journey";
import { readJourneySnapshot, verifiedNetworkFees } from "@/lib/journey-chain";
import { captureFoundryReceipt, journeyError } from "@/lib/journey-capture";
import { loadJourneyAlert } from "@/lib/journey-alert";
import { DEFAULT_RULE } from "@/lib/agents";
import { createWatch } from "@/lib/signal-box.functions";
import { useCloudSession } from "@/components/signal/account";
import type { FlightRecord } from "@/lib/recorder";
import hero from "@/assets/studio-loco-panoramic-hero.png.asset.json";

const Search = z.object({
  account: z.string().max(44).optional(),
  pool: z.string().max(44).optional(),
  owner: z.string().max(44).optional(),
  kind: z.enum(["position", "order"]).optional(),
  blueprint: z.string().max(80).optional(),
  alert: z.string().uuid().optional(),
});
export const Route = createFileRoute("/app/journey")({
  validateSearch: Search,
  head: () => ({
    meta: [
      { title: "The Journey · live strategy tracking — Studio Loco" },
      {
        name: "description",
        content:
          "Follow Foundry blueprints into verified Meteora positions, native order fills, fees and range changes. A durable timeline linked to Flight Recorder.",
      },
    ],
  }),
  component: () => <JourneyBoard initial={Route.useSearch()} />,
});
const token = (mint: string, side: string) =>
  mint === "So11111111111111111111111111111111111111112"
    ? "SOL / WSOL"
    : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : `Token ${side}`;
const when = (n: number) => new Date(n).toLocaleString();
const amount = (n: string, d: number) => formatUnits(n, d, Math.min(d, 9));

export function JourneyBoard({ initial = {} }: { initial?: z.infer<typeof Search> }) {
  const { connection } = useConnection(),
    { settings, hydrated } = useSettings();
  const [rows, setRows] = useState<Journey[]>([]),
    [selected, setSelected] = useState("");
  const [records, setRecords] = useState<FlightRecord[]>([]),
    [blueprints, setBlueprints] = useState<SavedBlueprint[]>([]);
  const [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState(""),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false),
    [polling, setPolling] = useState(true),
    [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({
    kind: initial.kind ?? "position",
    account: initial.account ?? "",
    pool: initial.pool ?? "",
    owner: initial.owner ?? "",
    label: "",
  });
  const [adding, setAdding] = useState(!!initial.account || !!initial.alert);
  const [alert, setAlert] = useState<Awaited<ReturnType<typeof loadJourneyAlert>> | null>(null);
  const ctl = useRef(new JobControl()),
    mounted = useRef(false),
    generation = useRef(0);
  const live = hydrated && settings.cluster === "mainnet-beta" && !settings.practice;
  const source = settings.rpc["mainnet-beta"] ? "custom" : "relay";
  const cur =
    rows.find((j) => j.id === selected) ??
    (initial.blueprint
      ? rows.find((j) => j.links.some((l) => l.blueprintId === initial.blueprint))
      : undefined) ??
    rows[0];
  const latest = cur?.snapshots.at(-1);
  const health = !live ? "historical" : cur ? snapshotHealth(cur, now) : "waiting";
  const modeKey = `${connection.rpcEndpoint}:${live}:${cur?.id ?? ""}`;
  useEffect(() => {
    generation.current++;
    ctl.current.invalidate();
  }, [modeKey]);
  useEffect(() => {
    mounted.current = true;
    ctl.current.mounted = true;
    const offBusy = ctl.current.subscribe(() => {
      if (mounted.current) setBusy(ctl.current.busy);
    });
    async function load() {
      try {
        const [j, r, b] = await Promise.all([listJourneys(), listRecords(), listBlueprints()]);
        if (mounted.current) {
          setRows(j);
          setRecords(r);
          setBlueprints(b);
          setStorageError("");
          setReady(true);
        }
      } catch (e) {
        if (mounted.current) {
          setStorageError(journeyError(e));
          setReady(true);
        }
      }
    }
    const a = subscribeJourney(() => {
        void load();
      }),
      b = subscribeRecorder(() => {
        void load();
      }),
      c = subscribeFoundry(() => {
        void load();
      });
    void load();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      ctl.current.unmount();
      offBusy();
      a();
      b();
      c();
      clearInterval(timer);
    };
  }, []);
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => {
    if (live && cur && !ctl.current.busy && !document.hidden) void refresh(cur);
  };
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => refreshRef.current(), JOURNEY_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);
  useEffect(() => {
    if (!initial.alert || !hydrated) return;
    let cancelled = false;
    void loadJourneyAlert(initial.alert).then(
      (a) => {
        if (cancelled) return;
        setAlert(a);
        setForm({ ...a.identity, label: "Journey · native order" });
        setAdding(true);
        setStatus("Private alert loaded. Verify the current account before continuing.");
      },
      (e) => {
        if (!cancelled) setError(journeyError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [initial.alert, hydrated]);
  function changeForm(change: Partial<typeof form>) {
    generation.current++;
    ctl.current.invalidate();
    setError("");
    setStatus("");
    setAlert(null);
    setForm((f) => ({ ...f, ...change }));
  }
  async function refresh(j: Journey) {
    if (!live || storageError) return;
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    try {
      const snapshot = await readJourneySnapshot(connection, j, job, source, j.snapshots.at(-1));
      job.check();
      const next = await saveJourney(appendSnapshot(j, snapshot), j);
      job.check();
      setRows((r) => r.map((p) => (p.id === j.id ? next : p)));
      setStatus(`Verified ${when(snapshot.observedAt)} · slot ${snapshot.slot.toLocaleString()}.`);
      const event = next.events.at(-1);
      if (event && event.at === snapshot.observedAt && event.kind !== "baseline")
        await recordFact({
          kind: "proposal",
          title: `Journey · ${j.label} · ${event.kind} change`,
          route: "/app/journey",
          cluster: "mainnet-beta",
          wallet: j.owner,
          context: {
            recordType: "journey-observation",
            account: j.account,
            pool: j.pool,
            observedAt: snapshot.observedAt,
            chainSlot: snapshot.slot,
            after: event.after,
            blueprintId: j.links.at(-1)?.blueprintId ?? null,
            blueprintRevision: j.links.at(-1)?.revision ?? null,
            blueprintDigest: j.links.at(-1)?.digest ?? null,
          },
          detail: event.detail,
        });
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        const msg = journeyError(e);
        setError(msg);
        try {
          await saveJourney({ ...j, lastAttempt: Date.now(), lastError: msg }, j);
        } catch {
          /* concurrent newer evidence wins */
        }
      }
    } finally {
      ctl.current.end(job);
    }
  }
  async function addWatch(e: React.FormEvent) {
    e.preventDefault();
    if (!live || storageError) return;
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setStatus("");
    try {
      const identity = JourneyIdentity.parse({
        kind: form.kind,
        account: form.account.trim(),
        pool: form.pool.trim(),
        owner: form.owner.trim(),
      });
      const previous = rows.find((j) => j.id === journeyId(identity));
      if (previous && (previous.owner !== identity.owner || previous.pool !== identity.pool))
        throw new Error("This account is tracked under a different identity.");
      const snapshot = await readJourneySnapshot(
        connection,
        identity,
        job,
        source,
        previous?.snapshots.at(-1),
      );
      job.check();
      if (
        alert &&
        (snapshot.mintX !== alert.expected.mintX ||
          snapshot.mintY !== alert.expected.mintY ||
          snapshot.binStep !== alert.expected.binStep)
      )
        throw new Error("Fresh account identity differs from the private watch.");
      const saved = await saveJourney(
        appendSnapshot(
          previous ?? newJourney(identity, form.label.trim() || `My ${form.kind} journey`),
          snapshot,
        ),
        previous,
      );
      job.check();
      setSelected(saved.id);
      setAdding(false);
      setStatus(
        "Verified account added. This is a watch-only association; it does not claim a Foundry action created it.",
      );
      await recordFact({
        kind: "proposal",
        title: `Journey account verified · ${saved.label}`,
        route: "/app/journey",
        cluster: "mainnet-beta",
        wallet: identity.owner,
        context: {
          recordType: "journey-baseline",
          account: identity.account,
          pool: identity.pool,
          accountKind: identity.kind,
          observedAt: snapshot.observedAt,
          chainSlot: snapshot.slot,
          corroborationSlot: snapshot.checkedSlot,
          watchOnly: saved.links.length === 0,
        },
        detail:
          "Public account identity verified and device observation persisted. No execution authorization or inferred Foundry origin.",
      });
      if (alert)
        await recordFact({
          kind: "alert-handoff",
          title: "Journey · native order alert reviewed",
          route: "/app/journey",
          cluster: "mainnet-beta",
          wallet: identity.owner,
          links: { alertId: alert.alertId, watchId: alert.watchId },
          context: {
            recordType: "journey-order-handoff",
            account: identity.account,
            pool: identity.pool,
            freshSlot: snapshot.slot,
          },
          detail:
            "Private watch identifiers loaded; account independently reverified. No executable transaction was carried by the alert.",
        });
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) setError(journeyError(e));
    } finally {
      ctl.current.end(job);
    }
  }
  async function linkReceipt(r: FlightRecord, b: SavedBlueprint) {
    if (!live || storageError) return;
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setStatus("Reading the confirmed transaction and resulting account…");
    try {
      const j = await captureFoundryReceipt(connection, r, b, job, source);
      job.check();
      setSelected(j.id);
      setStatus(
        "Confirmed action and account independently verified. Exact blueprint revision linked.",
      );
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        setError(journeyError(e));
        setStatus("");
      }
    } finally {
      ctl.current.end(job);
    }
  }
  function download(j: Journey) {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "studio-loco/journey-observations",
              exportedAt: Date.now(),
              evidence: "device observations; not authenticated history or executable inputs",
              journey: j,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `studio-loco-journey-${j.account}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function remove(j: Journey) {
    if (
      !confirm(
        "Remove this device watch and its local snapshots? Hosted Signal Box watches are managed separately.",
      )
    )
      return;
    try {
      await removeJourney(j);
      setSelected("");
    } catch (e) {
      setError(journeyError(e));
    }
  }
  const pending = records.flatMap((r) => {
    const b = blueprints.find((b) => foundryCandidate(r, b.blueprint, b.digest));
    if (!b || (initial.blueprint && b.blueprint.id !== initial.blueprint)) return [];
    const linked = rows.some((j) =>
      j.links.some((l) => l.recordId === r.id && l.digest === b.digest),
    );
    return linked ? [] : [{ r, b }];
  });
  return (
    <div className="space-y-6">
      <section
        className="relative isolate overflow-hidden border border-amber/30 bg-[#111827]"
        aria-label="The Journey introduction"
      >
        <div className="grid lg:grid-cols-[1fr_1.08fr]">
          <div className="relative z-10 px-6 py-8 sm:p-10">
            <p className="station-code flex items-center gap-2 text-amber">
              <Waypoints size={16} /> ST-13 · THE JOURNEY
            </p>
            <h1 className="display mt-5 text-4xl leading-tight sm:text-5xl xl:text-6xl">
              Your strategy.
              <br />
              <span className="text-amber">Its story.</span>
            </h1>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-cream/75">
              Follow a blueprint beyond the signature. Verified positions, native order levels and a
              record of what changed along the way.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Btn onClick={() => setAdding((a) => !a)}>
                <MapPin size={15} /> Track an account
              </Btn>
              <Link to="/app/foundry" className={btn({ variant: "line" })}>
                Open Foundry <ArrowRight size={15} />
              </Link>
            </div>
            <p className="station-code mt-6 text-[10px] text-cream/50">
              MAINNET DLMM · READ-ONLY OBSERVATION · DEVICE HISTORY
            </p>
          </div>
          <div className="relative min-h-64 border-l border-amber/20 bg-[#1b273b] p-5 sm:p-7">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_45%,#00000030)]" />
            <div className="relative h-full min-h-60 overflow-hidden rounded-t-[70px] border-[10px] border-[#8c7145] shadow-[0_0_0_2px_#baa375,inset_0_0_40px_#000]">
              <img
                src={hero.url}
                alt="The Studio Loco train crossing a golden landscape toward its next station"
                className="absolute inset-0 h-full w-full object-cover object-[68%_center]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-midnight/80 via-transparent to-transparent" />
              <div className="absolute bottom-5 left-5 right-5 flex items-center justify-between border-t border-cream/40 pt-3 text-cream">
                <span className="station-code text-[10px]">
                  FOUNDRY → ONCHAIN → FLIGHT RECORDER
                </span>
                <span className="size-2 rounded-full bg-amber shadow-[0_0_12px_#e6ac50]" />
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 border-t border-line bg-midnight/70 px-6 py-4 sm:px-10">
          <Stat label="Tracked accounts" value={rows.length} />
          <Stat
            label="Verified receipt links"
            value={rows.reduce((n, j) => n + j.links.length, 0)}
          />
          <Stat label="Saved snapshots" value={rows.reduce((n, j) => n + j.snapshots.length, 0)} />
        </div>
      </section>
      {!live && (
        <Notice tone="warn" title="Mainnet live mode required">
          Switch to mainnet and turn off Practice in Settings to verify accounts. Existing
          observations remain historical.
        </Notice>
      )}
      {storageError && (
        <Notice tone="error" title="Device evidence unavailable">
          {storageError} Reload to retry; no new observations are claimed as saved.
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Verification incomplete">
          {error}
        </Notice>
      )}
      {status && (
        <p role="status" className="text-sm text-cream/75">
          {status}
        </p>
      )}
      {adding && (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="display text-2xl">Start with the account.</h2>
            <Btn
              variant="ghost"
              size="sm"
              onClick={() => {
                ctl.current.invalidate();
                setAdding(false);
              }}
            >
              Close
            </Btn>
          </div>
          <p className="mt-2 text-sm text-cream/65">
            Public, watch-only tracking. We verify the program, account type, owner, pool and mint
            pair before saving.
          </p>
          {alert && (
            <p className="mt-3 border-l-2 border-amber pl-3 text-sm text-amber">
              Signal Box · {alert.reason}
              <br />
              <span className="text-cream/60">
                Alert observed {alert.observedAt}; fresh verification required.
              </span>
            </p>
          )}
          <form className="mt-5 space-y-4" onSubmit={addWatch}>
            <Segmented
              value={form.kind}
              options={[
                { value: "position", label: "LP position" },
                { value: "order", label: "Native order account" },
              ]}
              onChange={(kind) => changeForm({ kind })}
              label="Account type"
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Account address"
                value={form.account}
                onChange={(e) => changeForm({ account: e.target.value })}
              />
              <Field
                label="Pool address"
                value={form.pool}
                onChange={(e) => changeForm({ pool: e.target.value })}
              />
              <Field
                label="Owner address"
                value={form.owner}
                onChange={(e) => changeForm({ owner: e.target.value })}
              />
              <Field
                label="Journey name"
                maxLength={80}
                value={form.label}
                onChange={(e) => changeForm({ label: e.target.value })}
                placeholder="My liquidity route"
              />
            </div>
            <Btn type="submit" disabled={busy || !live || !!storageError}>
              {busy ? (
                <Spinner label="Verifying account" />
              ) : (
                <>
                  <Check size={15} /> Verify & track
                </>
              )}
            </Btn>
          </form>
        </Panel>
      )}
      {!!pending.length && (
        <Panel>
          <p className="station-code text-amber">
            CONFIRMED FOUNDRY RECEIPTS · {pending.length} awaiting account verification
          </p>
          <p className="mt-2 text-sm text-cream/65">
            Automatic capture runs after confirmation. Missing metadata, closed accounts or storage
            errors require a fresh retry here. No link is called verified until it passes.
          </p>
          <div className="mt-4 space-y-3">
            {pending.slice(0, 10).map(({ r, b }) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3"
              >
                <span className="text-sm">
                  {b.blueprint.name} · r{b.blueprint.revision} ·{" "}
                  {String(r.context["foundryAction"])}
                </span>
                <Btn
                  variant="line"
                  size="sm"
                  disabled={busy || !live || !!storageError}
                  onClick={() => void linkReceipt(r, b)}
                >
                  Verify receipt & account
                </Btn>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {!ready ? (
        <Spinner label="Reading device Journeys" />
      ) : !rows.length ? (
        <Panel>
          <div className="mx-auto max-w-2xl py-5 text-center">
            <Waypoints className="mx-auto text-amber" size={30} />
            <h2 className="display mt-4 text-3xl">Every route needs a first stop.</h2>
            <p className="mt-3 text-sm leading-relaxed text-cream/65">
              Execute a saved Foundry blueprint to link its confirmed account automatically, or
              track a public position or native order account. Your first successful read starts the
              timeline.
            </p>
            <div className="mt-6 grid gap-4 text-left sm:grid-cols-3">
              {[
                ["01", "Verify the origin", "Exact revision, digest and confirmed receipt."],
                ["02", "Observe the route", "Holdings, bins, fees and native order changes."],
                ["03", "Choose the next move", "Alerts and a fresh Rebalance Planner review."],
              ].map(([n, title, text]) => (
                <div key={n} className="border-t border-amber/35 pt-3">
                  <span className="station-code text-amber">{n}</span>
                  <p className="mt-2 text-sm">{title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-cream/55">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[280px_1fr]">
          <aside className="space-y-3">
            <p className="station-code text-cream/55">YOUR ROUTES · THIS DEVICE</p>
            {rows.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => {
                  generation.current++;
                  ctl.current.invalidate();
                  setSelected(j.id);
                  setError("");
                  setStatus("");
                }}
                aria-pressed={cur?.id === j.id}
                className={`w-full border p-4 text-left transition-colors ${cur?.id === j.id ? "border-amber bg-amber/5" : "border-line hover:border-cream/40"}`}
              >
                <span className="station-code text-[10px] text-amber">
                  {j.kind === "position" ? "LP POSITION" : "NATIVE ORDER"} ·{" "}
                  {snapshotHealth(j, now)}
                </span>
                <span className="display mt-2 block text-lg">{j.label}</span>
                <span className="mt-2 block font-mono text-xs text-cream/60">
                  {shortAddr(j.account)}
                </span>
                <span className="mt-2 block text-xs text-cream/50">
                  {j.links.length
                    ? `${j.links.length} verified Foundry link${j.links.length === 1 ? "" : "s"}`
                    : "Watch-only · no blueprint proof"}
                </span>
              </button>
            ))}
          </aside>
          {cur && (
            <div className="space-y-5">
              <Panel>
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <p className="station-code flex items-center gap-2 text-amber">
                      <Radio size={13} /> {health.toUpperCase()} ·{" "}
                      {cur.kind === "position" && latest?.kind === "position"
                        ? rangeHealth(latest)
                        : latest?.kind === "order"
                          ? `${latest.levels.length} active levels`
                          : "waiting for account"}
                    </p>
                    <h2 className="display mt-2 text-3xl">{cur.label}</h2>
                    <p className="mt-2 break-all font-mono text-xs text-cream/65">{cur.account}</p>
                  </div>
                  <Btn
                    size="sm"
                    variant="line"
                    disabled={busy || !live || !!storageError}
                    onClick={() => void refresh(cur)}
                  >
                    <RefreshCw size={14} /> {busy ? "Reading…" : "Refresh account"}
                  </Btn>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-cream/60">
                  <span>Pool {shortAddr(cur.pool)}</span>
                  <span>Owner {shortAddr(cur.owner)}</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={polling}
                      onChange={(e) => setPolling(e.target.checked)}
                      className="accent-[var(--amber)]"
                    />{" "}
                    Read every 60s while this tab is visible
                  </label>
                </div>
                {(cur.lastError || health === "stale") && (
                  <p className="mt-4 border-l-2 border-amber pl-3 text-sm text-amber">
                    {cur.lastError ??
                      "No fresh snapshot. Values below are historical; refresh before making a decision."}
                  </p>
                )}
                {latest && (
                  <p className="mt-4 text-xs leading-relaxed text-cream/55">
                    Verified {when(latest.observedAt)} · confirmed identity slot{" "}
                    {latest.slot.toLocaleString()} → corroboration slot{" "}
                    {latest.checkedSlot.toLocaleString()} · {latest.source} RPC. Holdings and fees
                    are SDK calculations across multiple confirmed reads, not an atomic slot
                    snapshot. Freshness expires after {JOURNEY_STALE_MS / 1000}s. No index
                    dependency or historical fill backfill.
                  </p>
                )}
              </Panel>
              {latest && (
                <>
                  <SnapshotDetails snapshot={latest} />
                  <Panel>
                    <p className="station-code text-amber">CAPITAL, FEES & ACCOUNT COSTS</p>
                    <div className="mt-4 grid gap-4 sm:grid-cols-3">
                      <Stat
                        label="Linked action network fees"
                        value={
                          cur.links.length
                            ? `${amount(verifiedNetworkFees(cur), 9)} SOL`
                            : "Unavailable"
                        }
                        sub={
                          cur.links.length
                            ? "Verified linked transactions, deduplicated; owner as fee payer"
                            : "No verified action receipts; total spending unavailable"
                        }
                      />
                      <Stat
                        label="Account SOL locked"
                        value={`${amount(latest.accountLamports, 9)} SOL`}
                        sub="Current account lamports; not a realized expense"
                      />
                      <Stat
                        label="Rent minimum"
                        value={`${amount(latest.rentMinimumLamports, 9)} SOL`}
                        sub="Recoverable only after eligible close; recipient not inferred"
                      />
                    </div>
                    <p className="mt-4 text-xs leading-relaxed text-cream/60">
                      Network spending covers linked Foundry receipts only. Other transactions,
                      bin-array rent, funding, transfers and close refunds are outside this total.
                      Claimed fees are lifetime account counters where available; unclaimed fees
                      remain in the position/order. These figures are not PnL or an execution
                      recommendation.
                    </p>
                  </Panel>
                </>
              )}
              <Panel>
                <p className="station-code flex items-center gap-2 text-amber">
                  <Fingerprint size={14} /> BLUEPRINT ORIGIN
                </p>
                {!cur.links.length ? (
                  <p className="mt-3 text-sm text-cream/65">
                    Verified public account watch. No confirmed Foundry association has been
                    established.
                  </p>
                ) : (
                  <div className="mt-3 space-y-4">
                    {cur.links
                      .slice()
                      .reverse()
                      .map((l) => (
                        <div
                          key={`${l.signature}:${l.digest}`}
                          className="border-t border-line pt-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm">
                              {l.name} · revision {l.revision} · {l.action}
                            </p>
                            <Link
                              to="/app/recorder"
                              search={{ id: l.recordId }}
                              className="text-xs text-amber underline"
                            >
                              Open action in Flight Recorder
                            </Link>
                          </div>
                          <p className="mt-2 break-all font-mono text-[10px] text-cream/50">
                            SHA-256 {l.digest}
                          </p>
                          <a
                            href={explorerTx(l.signature, "mainnet-beta")}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-xs text-cream/60 underline"
                          >
                            Confirmed transaction · slot {l.slot.toLocaleString()}
                          </a>
                        </div>
                      ))}
                  </div>
                )}
                <p className="mt-4 text-xs text-cream/50">
                  The chain verifies the signer, native DLMM instruction and resulting account.
                  Revision and digest identify saved local configuration; they are not onchain
                  strategy metadata.
                </p>
              </Panel>
              <Panel>
                <div className="flex items-center justify-between gap-3">
                  <p className="station-code text-amber">THE FLIGHT PATH</p>
                  <span className="station-code text-[10px] text-cream/50">
                    {cur.snapshots.length} SAVED READS
                  </span>
                </div>
                <ol className="mt-5 space-y-0">
                  {cur.events
                    .slice()
                    .reverse()
                    .slice(0, 30)
                    .map((e) => (
                      <li key={e.id} className="relative ml-2 border-l border-cream/20 pb-5 pl-6">
                        <span className="absolute -left-[5px] top-1 size-2.5 rounded-full border border-midnight bg-amber" />
                        <p className="text-sm leading-relaxed">{e.detail}</p>
                        <p className="mt-1 text-[11px] text-cream/50">
                          {e.after
                            ? `Observed between ${when(e.after)} and ${when(e.at)}`
                            : `Baseline ${when(e.at)}`}{" "}
                          · slot {e.slot.toLocaleString()}
                        </p>
                      </li>
                    ))}
                </ol>
                {!cur.events.length && (
                  <p className="mt-4 text-sm text-cream/60">
                    A successful account read starts the timeline.
                  </p>
                )}
                <p className="text-xs text-cream/50">
                  Stores the latest 48 snapshots and 200 changes. Earlier reads dropped:{" "}
                  {cur.omittedSnapshots}; changes dropped: {cur.omittedEvents}. Showing the newest
                  30 changes. Export preserves all retained evidence.
                </p>
              </Panel>
              <JourneyActions
                journey={cur}
                snapshot={latest}
                disabled={!live || health !== "verified" || busy}
              />
              <div className="flex flex-wrap justify-between gap-3">
                <Btn variant="line" size="sm" onClick={() => download(cur)}>
                  <Download size={14} /> Export Journey evidence
                </Btn>
                <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void remove(cur)}>
                  Remove device watch
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SnapshotDetails({ snapshot: s }: { snapshot: JourneySnapshot }) {
  const x = token(s.mintX, "X"),
    y = token(s.mintY, "Y");
  return (
    <Panel>
      <p className="station-code text-amber">VERIFIED ACCOUNT STATE</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={s.kind === "position" ? "LP holdings · X" : "Withdrawable · X"}
          value={`${amount(s.holdingsX, s.decX)} ${x}`}
        />
        <Stat
          label={s.kind === "position" ? "LP holdings · Y" : "Withdrawable · Y"}
          value={`${amount(s.holdingsY, s.decY)} ${y}`}
        />
        <Stat label="Unclaimed fee · X" value={`${amount(s.feeX, s.decX)} ${x}`} />
        <Stat label="Unclaimed fee · Y" value={`${amount(s.feeY, s.decY)} ${y}`} />
      </div>
      {s.kind === "position" ? (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Stat
              label="Range"
              value={`${s.lower} → ${s.upper}`}
              sub={`Active ${s.activeId} · ${s.binStep} bps bin step`}
            />
            <Stat label="Lifetime claimed · X" value={`${amount(s.claimedX, s.decX)} ${x}`} />
            <Stat label="Lifetime claimed · Y" value={`${amount(s.claimedY, s.decY)} ${y}`} />
          </div>
          <p className="mt-3 text-xs text-cream/50">
            Fee authority {shortAddr(s.feeOwner)} · counters predate this Journey. Holdings exclude
            unclaimed fees. Pro-rata amounts are floored to whole base units.
          </p>
          <details className="mt-5">
            <summary className="cursor-pointer text-sm text-amber">
              Per-bin position holdings · {s.bins.length} bins
            </summary>
            <div className="mt-3 max-h-64 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="station-code text-cream/55">
                  <tr>
                    <th className="py-2">Bin</th>
                    <th>Token X</th>
                    <th>Token Y</th>
                    <th>Liquidity shares</th>
                  </tr>
                </thead>
                <tbody>
                  {s.bins.map((b) => (
                    <tr
                      key={b.binId}
                      className={`border-t border-line ${b.binId === s.activeId ? "text-amber" : "text-cream/70"}`}
                    >
                      <td className="py-2">
                        {b.binId}
                        {b.binId === s.activeId ? " · active" : ""}
                      </td>
                      <td>{amount(b.x, s.decX)}</td>
                      <td>{amount(b.y, s.decY)}</td>
                      <td className="font-mono">{b.shares}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[590px] text-left text-sm">
              <caption className="sr-only">
                Native order levels, filled input and received output
              </caption>
              <thead className="station-code text-cream/50">
                <tr>
                  <th className="pb-3">Level</th>
                  <th>Status</th>
                  <th>Unfilled input</th>
                  <th>Filled input</th>
                  <th>Output before fees</th>
                </tr>
              </thead>
              <tbody>
                {s.levels.map((l) => (
                  <tr key={`${l.side}:${l.binId}`} className="border-t border-line">
                    <td className="py-3">
                      {l.side} · bin {l.binId}
                    </td>
                    <td className={l.state === "filled" ? "text-success" : "text-amber"}>
                      {l.state}
                    </td>
                    <td>
                      {l.side === "sell"
                        ? `${amount(l.unfilledX, s.decX)} ${x}`
                        : `${amount(l.unfilledY, s.decY)} ${y}`}
                    </td>
                    <td>
                      {l.side === "sell"
                        ? `${amount(l.filledX, s.decX)} ${x}`
                        : `${amount(l.filledY, s.decY)} ${y}`}
                    </td>
                    <td>
                      {l.side === "sell"
                        ? `${amount(l.proceedsY, s.decY)} ${y}`
                        : `${amount(l.proceedsX, s.decX)} ${x}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!s.levels.length && (
            <p className="text-sm text-cream/65">
              The verified order account has no populated levels. Closure and prior fills are not
              inferred.
            </p>
          )}
          <p className="mt-4 text-xs leading-relaxed text-cream/55">
            Withdrawable holdings include resting input, swap output and current fees after transfer
            fees. Filled input is not earned output. Order accounts do not expose lifetime
            claimed-fee counters; claimed fees are unavailable here. A disappeared account is a
            missing read, not evidence of a fill or withdrawal.
          </p>
        </>
      )}
    </Panel>
  );
}
function JourneyActions({
  journey: j,
  snapshot: s,
  disabled,
}: {
  journey: Journey;
  snapshot?: JourneySnapshot;
  disabled: boolean;
}) {
  const create = useServerFn(createWatch),
    { userId } = useCloudSession();
  const [busy, setBusy] = useState(false),
    [msg, setMsg] = useState("");
  useEffect(() => setMsg(""), [j.id]);
  async function watch() {
    if (!userId || disabled || busy || !s) return;
    setBusy(true);
    setMsg("");
    try {
      const result =
        j.kind === "order"
          ? await create({
              data: {
                kind: "order",
                account: j.account,
                pool: j.pool,
                owner: j.owner,
                label: `Journey · ${j.label}`.slice(0, 80),
              },
            })
          : await create({
              data: {
                kind: "position",
                position: j.account,
                pool: j.pool,
                owner: j.owner,
                label: `Journey · ${j.label}`.slice(0, 80),
                rule: { ...DEFAULT_RULE, edgeBuffer: 3, rebalanceOnExit: true },
              },
            });
      setMsg(
        result.ok
          ? "Hosted watch created with a fresh server read. Checks every 5 minutes, expires in 7 days; manage and enable optional notifications in Signal Box."
          : result.error,
      );
    } catch (e) {
      setMsg(journeyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel tone="cobalt">
      <p className="station-code text-amber">YOUR NEXT STATION</p>
      <h3 className="display mt-2 text-2xl">Observe. Then choose.</h3>
      <p className="mt-2 text-sm leading-relaxed text-cream/70">
        {j.kind === "position"
          ? "Open this owner and position in Agents to compare routes with Rebalance Planner. It rereads the chain, simulates a new action and asks your wallet."
          : "Review this pool’s native orders to withdraw or close eligible levels. Every action starts with fresh account data and its own wallet review."}
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        {j.kind === "position" ? (
          <Link to="/app/agents" search={{ inspect: j.owner, focus: j.account }} className={btn()}>
            Open Rebalance Planner <ArrowRight size={14} />
          </Link>
        ) : (
          <Link
            to="/app/pool/$address"
            params={{ address: j.pool }}
            search={{ tab: "orders" }}
            className={btn()}
          >
            Review native orders <ArrowRight size={14} />
          </Link>
        )}
        <Btn
          variant="line"
          disabled={disabled || busy || !userId || !s}
          onClick={() => void watch()}
        >
          <Bell size={14} />{" "}
          {busy
            ? "Verifying hosted watch…"
            : j.kind === "order"
              ? "Enable hosted fill alerts"
              : "Enable hosted range alerts"}
        </Btn>
        <Link to="/app/signal-box" className={btn({ variant: "ghost" })}>
          Signal Box
        </Link>
      </div>
      {!userId && (
        <p className="mt-3 text-xs text-cream/60">
          Sign in to Signal Box to create a private hosted watch. Device snapshots continue while
          this page is open.
        </p>
      )}
      {msg && (
        <p role="status" className="mt-3 text-sm text-amber">
          {msg}
        </p>
      )}
      <p className="mt-3 text-xs text-cream/50">
        Hosted watches are observation only, subject to the five-watch account limit. Alerts use
        successful read intervals; gaps reset the order baseline. No background execution.
      </p>
    </Panel>
  );
}

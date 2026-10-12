import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  ArrowRight,
  Check,
  Download,
  Fingerprint,
  GitBranch,
  RefreshCw,
  TrainFront,
  Upload,
} from "lucide-react";
import { Btn, Field, Notice, Panel, Spinner, Stat, btn } from "@/components/kit";
import { formatUnits } from "@/lib/amount";
import { explorerTx, shortAddr } from "@/lib/format";
import { JobControl, JobCancelled } from "@/lib/job-control";
import { journeyError } from "@/lib/journey-capture";
import { journeyId, snapshotHealth, type Journey } from "@/lib/journey";
import type { FlightRecord } from "@/lib/recorder";
import {
  listStrategies,
  migrateJourneys,
  removeStrategy,
  restoreOrigins,
  saveStrategy,
  subscribeContinuity,
} from "@/lib/continuity-store";
import {
  eligibleStrategies,
  preparedCandidates,
  reconcileContinuity,
} from "@/lib/continuity-capture";
import {
  chapterId,
  compareByMint,
  exportContinuity,
  manualStrategy,
  parseContinuityImport,
  stageStatus,
  strategyCosts,
  type Chapter,
  type SnapshotSummary,
  type Strategy,
} from "@/lib/continuity";

const date = (n: number) => new Date(n).toLocaleString();
const token = (mint: string) =>
  mint === "So11111111111111111111111111111111111111112"
    ? "SOL / WSOL"
    : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : shortAddr(mint);
const stageLabel = {
  pending: "Source pending verification",
  "withdrawal-confirmed": "Source verified · deposit next",
  "deposit-pending": "Destination pending verification",
  complete: "Both stages verified",
  interrupted: "Interrupted · inspect receipts",
};
const MAX_FILE_BYTES = 10_000_000;

export function ContinuityBoard({
  journeys,
  records,
  live,
  source,
  blueprint,
  onAccount,
}: {
  journeys: Journey[];
  records: FlightRecord[];
  live: boolean;
  source: "relay" | "custom";
  blueprint?: string;
  onAccount: (id: string) => void;
}) {
  const { connection } = useConnection();
  const [strategies, setStrategies] = useState<Strategy[]>([]),
    [selected, setSelected] = useState("");
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false),
    [page, setPage] = useState(1),
    [grouping, setGrouping] = useState(false);
  const [label, setLabel] = useState(""),
    [groupAccount, setGroupAccount] = useState("");
  const [removing, setRemoving] = useState(false);
  const mounted = useRef(false),
    ctl = useRef(new JobControl());
  const current =
    strategies.find((s) => s.id === selected) ??
    (blueprint ? strategies.find((s) => s.origin?.blueprintId === blueprint) : undefined) ??
    strategies[0];
  const id = current?.id;
  useEffect(() => {
    ctl.current.invalidate();
    setPage(1);
    setRemoving(false);
  }, [id, connection, live]);
  useEffect(() => {
    mounted.current = true;
    ctl.current.mounted = true;
    const offBusy = ctl.current.subscribe(() => {
      if (mounted.current) setBusy(ctl.current.busy);
    });
    const off = subscribeContinuity(() => {
      void reload();
    });
    void reload();
    return () => {
      mounted.current = false;
      ctl.current.unmount();
      offBusy();
      off();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void migrateJourneys(journeys).then(
      () => {
        if (!cancelled) void reload();
      },
      (e) => {
        if (!cancelled && mounted.current) setError(journeyError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [journeys]);
  async function reload() {
    try {
      const rows = await listStrategies();
      if (mounted.current) {
        setStrategies(rows);
        setReady(true);
      }
    } catch (e) {
      if (mounted.current) {
        setError(journeyError(e));
        setReady(true);
      }
    }
  }
  async function verify() {
    if (!live || !current || current.provenance !== "verified") return;
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setMessage("Reading successful transaction metadata and account identities…");
    try {
      const report = await reconcileContinuity(connection, job, source, current.id, 6);
      job.check();
      setMessage(
        report.verified +
          " chapter(s) verified. " +
          (report.errors.length
            ? "Some evidence is still unavailable; review the notice and retry later."
            : "No wallet transaction was built or replayed."),
      );
      if (report.errors.length) setError(report.errors[0]!);
      await reload();
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        setError(journeyError(e));
        setMessage("");
      }
    } finally {
      ctl.current.end(job);
    }
  }
  function download(rows: Strategy[]) {
    try {
      const text = JSON.stringify(exportContinuity(rows), null, 2);
      if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES)
        throw new Error("Export exceeds 10 MB. Export an individual strategy instead.");
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "studio-loco-continuity-" + Date.now() + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Continuity evidence exported. It contains observations and public receipt references; no executable transaction inputs.",
      );
    } catch (e) {
      setError(journeyError(e));
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Continuity bundle exceeds 10 MB.");
      const bundle = parseContinuityImport(await file.text());
      const existing = await listStrategies();
      let saved = 0;
      for (const s of bundle.strategies) {
        if (
          existing.some(
            (x) => x.id === s.id || (x.provenance === "import" && x.suppliedId === s.suppliedId),
          )
        )
          continue;
        await saveStrategy(s);
        existing.push(s);
        saved++;
      }
      await reload();
      setMessage(
        saved +
          " supplied strategy record(s) imported; " +
          bundle.rejected +
          " rejected. Imported history is never promoted to verified ancestry.",
      );
    } catch (e) {
      setError(journeyError(e));
    }
  }
  async function group() {
    try {
      const j = journeys.find((j) => j.id === groupAccount);
      if (!j) throw new Error("Choose a tracked account first.");
      const strategy = await saveStrategy(
        manualStrategy(label.trim(), {
          kind: j.kind,
          account: j.account,
          pool: j.pool,
          owner: j.owner,
        }),
      );
      setSelected(strategy.id);
      setGrouping(false);
      setLabel("");
      await reload();
    } catch (e) {
      setError(journeyError(e));
    }
  }
  async function addGroupAccount() {
    try {
      const j = journeys.find((j) => j.id === groupAccount);
      if (!j || !current || current.provenance !== "user-supplied")
        throw new Error("Choose a watch-only group and account.");
      if (current.accounts.some((a) => a.account === j.account))
        throw new Error("This account is already in the group.");
      await saveStrategy(
        {
          ...current,
          accounts: [
            ...current.accounts,
            {
              kind: j.kind,
              account: j.account,
              pool: j.pool,
              owner: j.owner,
              role: "watch",
              verification: "user-supplied",
              joinedBy: null,
              fromAccount: null,
              joinedAt: Date.now(),
              joinedSlot: null,
              closed: null,
            },
          ],
        },
        current,
      );
      await reload();
    } catch (e) {
      setError(journeyError(e));
    }
  }
  async function remove() {
    if (!current) return;
    try {
      await removeStrategy(current);
      setSelected("");
      await reload();
      setRemoving(false);
      setMessage(
        "Strategy history removed from this device. Account observations and hosted watches are managed separately.",
      );
    } catch (e) {
      setError(journeyError(e));
    }
  }
  const candidates = preparedCandidates(records);
  const pending = current
    ? candidates.filter(
        (c) =>
          eligibleStrategies([current], c).length &&
          !current.chapters.some((ch) => ch.id === chapterId(c.signature, c.step, c.account)),
      )
    : [];
  const costs = current ? strategyCosts(current) : null;
  return (
    <section
      id="journey-continuity"
      className="min-w-0 space-y-5"
      aria-labelledby="continuity-heading"
    >
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-amber/25 pb-5">
        <div>
          <p className="station-code flex items-center gap-2 text-amber">
            <TrainFront size={16} /> ONE STRATEGY · EVERY CHAPTER
          </p>
          <h2 id="continuity-heading" className="display mt-2 text-3xl sm:text-4xl">
            Journey Continuity
          </h2>
          <p className="mt-2 max-w-xl text-sm text-cream/65">
            Keep the origin, accounts, decisions and receipts connected as your liquidity moves.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn
            size="sm"
            variant="line"
            onClick={() => setGrouping((v) => !v)}
            disabled={!journeys.length}
          >
            Create watch-only group
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            disabled={!journeys.some((j) => j.links.length)}
            onClick={() => {
              void restoreOrigins(journeys).then(
                async (count) => {
                  await reload();
                  setMessage(count + " origin strategy record(s) restored from account evidence.");
                },
                (e) => setError(journeyError(e)),
              );
            }}
          >
            Restore account origins
          </Btn>
          <label className={btn({ size: "sm", variant: "quiet" })}>
            <Upload size={14} /> Import evidence
            <input
              className="sr-only"
              aria-label="Import continuity evidence"
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {error && (
        <Notice
          tone="error"
          title="Continuity evidence unavailable"
          action={
            <Btn
              size="sm"
              variant="line"
              onClick={() => {
                setError("");
                void reload();
              }}
            >
              Retry device read
            </Btn>
          }
        >
          {error}
        </Notice>
      )}
      {message && (
        <p role="status" className="border-l-2 border-amber pl-4 text-sm text-cream/75">
          {message}
        </p>
      )}
      {!ready && <Spinner label="Reading strategy histories" />}
      {grouping && (
        <Panel>
          <p className="mb-4 text-sm text-cream/70">
            Manual associations remain watch-only. They do not claim a Foundry origin or
            transaction-verified ancestry.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Watch-only group name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
            <AccountPicker journeys={journeys} value={groupAccount} onChange={setGroupAccount} />
          </div>
          <Btn
            className="mt-4"
            disabled={!label.trim() || !groupAccount}
            onClick={() => void group()}
          >
            Save watch-only group
          </Btn>
        </Panel>
      )}
      {ready && !strategies.length && (
        <Panel tone="cobalt">
          <div className="flex gap-4">
            <GitBranch className="shrink-0 text-amber" size={30} />
            <div>
              <h3 className="display text-2xl">Liquidity carries its history.</h3>
              <p className="mt-2 max-w-2xl text-sm text-cream/75">
                A confirmed, independently checked Foundry receipt starts a strategy. Future
                wallet-approved actions become linked chapters. Your existing account watches stay
                available below.
              </p>
              <Link
                to="/app/foundry"
                className="mt-4 inline-flex items-center gap-2 text-sm text-amber underline"
              >
                Create a strategy in Foundry <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </Panel>
      )}
      {current && (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-2" aria-label="Strategy histories">
            {strategies.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setSelected(s.id);
                  setError("");
                  setMessage("");
                }}
                aria-pressed={s.id === current.id}
                className={
                  "w-full border p-4 text-left transition-colors " +
                  (s.id === current.id
                    ? "border-amber bg-amber/10"
                    : "border-line hover:border-cream/40")
                }
              >
                <span className="block break-words font-medium">{s.label}</span>
                <span className="station-code mt-2 block text-[10px] text-cream/55">
                  {s.provenance === "verified" ? "Checked local origin" : "Supplied association"} ·{" "}
                  {s.accounts.length} account(s)
                </span>
                <span className="mt-2 block text-xs text-cream/70">
                  {s.chapters.length} chapters · {s.stages.filter((st) => !st.deposit).length} open
                  moves
                </span>
              </button>
            ))}
          </aside>
          <div className="min-w-0 space-y-5">
            <Panel className="min-w-0 border-t-2 border-t-amber">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="station-code text-amber">
                    {current.provenance === "verified"
                      ? "LOCAL STRATEGY · CHAIN-CHECKED ACTIONS"
                      : "USER-SUPPLIED · READ-ONLY EVIDENCE"}
                  </p>
                  <h3 className="display mt-2 break-words text-3xl">{current.label}</h3>
                  <p className="mt-2 break-all font-mono text-[10px] text-cream/45">{current.id}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn
                    size="sm"
                    variant="line"
                    disabled={!live || busy || current.provenance !== "verified"}
                    onClick={() => void verify()}
                  >
                    <RefreshCw size={14} className={busy ? "motion-safe:animate-spin" : ""} />
                    {busy ? "Verifying…" : "Verify pending chapters"}
                  </Btn>
                  <Btn size="sm" variant="quiet" onClick={() => download([current])}>
                    <Download size={14} />
                    Export strategy
                  </Btn>
                </div>
              </div>
              {current.origin && (
                <div className="mt-5 flex gap-3 border-y border-line py-4">
                  <Fingerprint size={20} className="shrink-0 text-amber" />
                  <div className="min-w-0">
                    <p className="text-sm">
                      Original blueprint · {current.origin.name} · r{current.origin.revision}
                    </p>
                    <p className="mt-1 break-all font-mono text-[10px] text-cream/55">
                      SHA-256 {current.origin.digest}
                    </p>
                    <Link
                      to="/app/foundry"
                      className="mt-2 inline-block text-xs text-amber underline"
                    >
                      Open Strategy Foundry
                    </Link>
                  </div>
                </div>
              )}
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Linked accounts" value={current.accounts.length} />
                <Stat
                  label="Retained chapters"
                  value={current.chapters.length}
                  sub={
                    current.omittedChapters
                      ? current.omittedChapters + " older chapters omitted"
                      : "Bounded device history"
                  }
                />
                <Stat
                  label={
                    current.provenance === "verified"
                      ? "Retained network fees"
                      : "Supplied fee figures"
                  }
                  value={costs ? formatUnits(costs.lamports, 9) + " SOL" : "—"}
                  sub={
                    costs?.unknown
                      ? costs.unknown + " transaction cost(s) unknown"
                      : "Deduplicated by signature"
                  }
                />
              </div>
              <p className="mt-5 text-xs leading-relaxed text-cream/55">
                Each action and account is checked separately. The strategy association is local
                evidence; fungible capital is not traced between transactions. Network fees may be
                shared with other actions. Rent, transfers, refunds, PnL and investment returns are
                not inferred.
              </p>
              {current.provenance !== "verified" && (
                <div className="mt-4">
                  <Notice tone="warn" title="Supplied history">
                    This group or imported file does not authenticate its origin, ancestry or
                    recorded confirmations. It cannot enter automatic capture.
                  </Notice>
                </div>
              )}
              {current.conflicts.length > 0 && (
                <div className="mt-4">
                  <Notice tone="warn" title="Multiple blueprint origins">
                    This account has {current.conflicts.length} additional revision or blueprint
                    association(s). The original identity is retained; its full balance is not
                    attributed to one blueprint.
                    <details className="mt-2">
                      <summary className="cursor-pointer underline">
                        Inspect additional origins
                      </summary>
                      {current.conflicts.map((o) => (
                        <p
                          key={o.signature + o.digest}
                          className="mt-2 break-all font-mono text-xs"
                        >
                          {o.name} r{o.revision} · {o.digest}
                        </p>
                      ))}
                    </details>
                  </Notice>
                </div>
              )}
              {current.lastError && (
                <div className="mt-4">
                  <Notice tone="warn" title="Last verification unresolved">
                    {current.lastError} Earlier evidence is retained.
                  </Notice>
                </div>
              )}
              {pending.length > 0 && (
                <p className="mt-4 text-sm text-amber">
                  {pending.length} confirmed local action(s) still need independent continuity
                  verification.
                </p>
              )}
            </Panel>
            {current.stages.length > 0 && (
              <Panel>
                <h4 className="display mb-4 text-2xl">Pool moves</h4>
                <div className="space-y-3">
                  {current.stages.map((st) => (
                    <div key={st.planId} className="border border-line p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="station-code text-amber">
                          {stageLabel[stageStatus(st)]}
                        </span>
                        <Link
                          to="/app/recorder"
                          search={{
                            id:
                              current.chapters.find((c) => c.id === st.withdrawal)?.recordId ??
                              undefined,
                          }}
                          className="text-xs underline"
                        >
                          Source receipt
                        </Link>
                      </div>
                      <p className="mt-3 break-all text-sm">
                        {shortAddr(st.sourcePool)} <span className="mx-2 text-amber">→</span>{" "}
                        {st.destinationPool
                          ? shortAddr(st.destinationPool)
                          : "Destination not recorded"}
                      </p>
                      <p className="mt-2 text-xs text-cream/55">
                        Withdraw and deposit use separate approvals. A verified withdrawal does not
                        confirm a destination deposit.
                      </p>
                      {st.withdrawal &&
                        !st.deposit &&
                        st.destinationPool &&
                        current.provenance === "verified" && (
                          <Link
                            to="/app/pool/$address"
                            params={{ address: st.destinationPool }}
                            search={{ tab: "add", move: st.planId, cluster: "mainnet-beta" }}
                            className="mt-3 inline-flex items-center gap-2 text-sm text-amber underline"
                          >
                            Open fresh destination review <ArrowRight size={14} />
                          </Link>
                        )}
                      {st.deposit && (
                        <MoveComparison
                          strategy={current}
                          withdrawal={st.withdrawal!}
                          deposit={st.deposit}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
            )}
            <Panel>
              <h4 className="display mb-4 text-2xl">Connected accounts</h4>
              <div className="space-y-3">
                {current.accounts.map((a) => {
                  const j = journeys.find(
                    (j) => j.account === a.account && j.pool === a.pool && j.owner === a.owner,
                  );
                  return (
                    <div
                      key={a.account}
                      className="flex flex-wrap items-start justify-between gap-3 border-l-2 border-amber/40 pl-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm">
                          <span className="text-amber">{a.role}</span> · {a.kind} ·{" "}
                          {a.closed
                            ? current.provenance === "verified"
                              ? "Closure verified"
                              : "Supplied closure claim"
                            : j
                              ? snapshotHealth(j)
                              : "Observation unavailable"}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-cream/70">
                          {a.account}
                        </p>
                        <p className="mt-1 text-xs text-cream/50">
                          {a.fromAccount
                            ? "Linked from " + shortAddr(a.fromAccount)
                            : a.verification === "transaction"
                              ? "Transaction-bound account"
                              : "Manual account association"}
                        </p>
                      </div>
                      {j && (
                        <Btn size="sm" variant="quiet" onClick={() => onAccount(journeyId(j))}>
                          Account observations
                        </Btn>
                      )}
                    </div>
                  );
                })}
              </div>
              {current.provenance === "user-supplied" && (
                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <AccountPicker
                    journeys={journeys}
                    value={groupAccount}
                    onChange={setGroupAccount}
                  />
                  <Btn size="sm" disabled={!groupAccount} onClick={() => void addGroupAccount()}>
                    Add to watch-only group
                  </Btn>
                </div>
              )}
            </Panel>
            <Panel className="min-w-0">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h4 className="display text-2xl">Lifecycle chapters</h4>
                <span className="station-code text-cream/50">
                  {current.provenance === "import" ? "SUPPLIED" : "DEVICE HISTORY"}
                </span>
              </div>
              {!current.chapters.length ? (
                <p className="text-sm text-cream/65">
                  No transaction chapters in this group. Account observations remain available
                  separately.
                </p>
              ) : (
                <ol className="space-y-3 border-l border-amber/30 pl-4">
                  {[...current.chapters]
                    .reverse()
                    .slice(0, page * 8)
                    .map((ch) => (
                      <li key={ch.id} className="relative min-w-0">
                        <span
                          aria-hidden
                          className="absolute -left-[21px] top-5 size-2 border border-amber bg-midnight"
                        />
                        <ChapterCard chapter={ch} supplied={current.provenance !== "verified"} />
                      </li>
                    ))}
                </ol>
              )}
              {current.chapters.length > page * 8 && (
                <Btn
                  size="sm"
                  variant="line"
                  className="mt-5"
                  onClick={() => setPage((p) => p + 1)}
                >
                  Show eight more chapters
                </Btn>
              )}
            </Panel>
            <div className="flex flex-wrap items-center gap-3">
              <Btn size="sm" variant="ghost" onClick={() => setRemoving((v) => !v)}>
                Remove strategy history
              </Btn>
              {removing && (
                <>
                  <span className="text-xs text-cream/65">
                    Export first. This removes only this device's strategy record.
                  </span>
                  <Btn size="sm" variant="danger" onClick={() => void remove()}>
                    Confirm removal
                  </Btn>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AccountPicker({
  journeys,
  value,
  onChange,
}: {
  journeys: Journey[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block min-w-0 text-xs text-cream/70">
      Tracked account
      <select
        aria-label="Tracked account for grouping"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 block min-h-11 w-full max-w-xs border border-line bg-midnight px-3 text-sm text-cream"
      >
        <option value="">Choose an account</option>
        {journeys.map((j) => (
          <option key={j.id} value={j.id}>
            {j.label} · {shortAddr(j.account)}
          </option>
        ))}
      </select>
    </label>
  );
}
function ChapterCard({ chapter: ch, supplied }: { chapter: Chapter; supplied: boolean }) {
  return (
    <details className="min-w-0 border border-line bg-midnight/70">
      <summary className="cursor-pointer p-4 focus-visible:outline focus-visible:outline-amber">
        <span className="mr-2 inline-flex align-middle text-amber">
          <Check size={14} />
        </span>
        <span className="capitalize">{ch.action}</span>
        <span className="ml-3 text-xs text-cream/55">
          {shortAddr(ch.account)} · slot {ch.slot.toLocaleString()}
        </span>
        <span className="mt-1 block pl-6 text-xs text-cream/50">
          {supplied ? "Recorded verification claim" : "Independently checked"} ·{" "}
          {date(ch.verifiedAt)}
        </span>
      </summary>
      <div className="min-w-0 space-y-4 border-t border-line p-4">
        <p className="break-all font-mono text-[10px] text-cream/55">
          {ch.instructions.join(" · ")}
        </p>
        <div className="flex flex-wrap gap-4 text-xs">
          <a
            href={explorerTx(ch.signature, "mainnet-beta")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber underline"
          >
            Transaction
          </a>
          {ch.recordId && (
            <Link to="/app/recorder" search={{ id: ch.recordId }} className="underline">
              Flight Recorder
            </Link>
          )}
          {ch.reviewId && (
            <Link to="/app/recorder" search={{ id: ch.reviewId }} className="underline">
              Review
            </Link>
          )}
          {ch.alertId && (
            <Link to="/app/signal-box" search={{ alert: ch.alertId }} className="underline">
              Private alert
            </Link>
          )}
        </div>
        <p className="text-xs text-cream/70">
          Owner-paid network fee:{" "}
          {ch.feeLamports === null ? "Unknown" : formatUnits(ch.feeLamports, 9) + " SOL"} · account{" "}
          {ch.accountAfter === "closed" ? "closure checked" : ch.accountAfter}
        </p>
        <SnapshotComparison before={ch.before} after={ch.after} />
      </div>
    </details>
  );
}
function MoveComparison({
  strategy,
  withdrawal,
  deposit,
}: {
  strategy: Strategy;
  withdrawal: string;
  deposit: string;
}) {
  const a = strategy.chapters.find((c) => c.id === withdrawal),
    b = strategy.chapters.find((c) => c.id === deposit);
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-amber underline">
        Compare source before withdrawal with destination after deposit
      </summary>
      <div className="mt-4">
        <SnapshotComparison before={a?.before ?? null} after={b?.after ?? null} />
      </div>
    </details>
  );
}
export function SnapshotComparison({
  before,
  after,
}: {
  before: SnapshotSummary | null;
  after: SnapshotSummary | null;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ["Before observation", before],
          ["After observation", after],
        ].map(([label, snapshot]) => {
          const s = snapshot as SnapshotSummary | null;
          return (
            <div key={String(label)} className="border border-line p-3">
              <p className="station-code text-[10px] text-cream/65">{String(label)}</p>
              {s ? (
                <>
                  <p className="mt-2 text-xs">{date(s.observedAt)}</p>
                  <p className="mt-1 text-xs text-cream/55">
                    Identity slot {s.slot} · corroborated {s.checkedSlot}
                  </p>
                  <p className="mt-2 font-mono text-sm">
                    {s.lower === null
                      ? "Native order levels"
                      : "Range " + s.lower + " → " + s.upper}{" "}
                    · active {s.activeId}
                  </p>
                  <p className="mt-1 text-xs text-cream/55">
                    Bin step {s.binStep ?? "unknown"} · account {formatUnits(s.accountLamports, 9)}{" "}
                    SOL
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-cream/60">
                  Not retained or unavailable; no zero balance is substituted.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {(["holdings", "fees", "claimed"] as const).map((field) => (
        <AmountComparison key={field} before={before} after={after} field={field} />
      ))}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <BinAllocation snapshot={before} label="Before bins" />
        <BinAllocation snapshot={after} label="After bins" />
      </div>
      <p className="text-[11px] leading-relaxed text-cream/50">
        These are separate observations, not an atomic same-slot snapshot. Changes can include other
        account activity and market trades; they are not transaction output attribution or PnL.
        Native order amounts here describe remaining input; full fills and proceeds stay in account
        observations.
      </p>
    </div>
  );
}
function AmountComparison({
  before,
  after,
  field,
}: {
  before: SnapshotSummary | null;
  after: SnapshotSummary | null;
  field: "holdings" | "fees" | "claimed";
}) {
  const rows = compareByMint(before, after, field);
  const title = {
    holdings: "Token holdings",
    fees: "Unclaimed fees",
    claimed: "Account-lifetime claimed counters",
  }[field];
  return (
    <div className="min-w-0">
      <p className="station-code mb-2 text-[10px] text-cream/70">{title}</p>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[390px] text-left text-xs">
            <thead>
              <tr className="border-b border-line text-cream/55">
                <th className="py-2">Token</th>
                <th>Before</th>
                <th>After</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint} className="border-b border-line/50">
                  <th className="py-2 pr-3 font-normal" title={r.mint}>
                    {token(r.mint)}
                  </th>
                  {[r.before, r.after, r.delta].map((v, i) => (
                    <td
                      key={i}
                      className="pr-3 font-mono"
                      title={v === null ? "Unavailable" : v + " base units"}
                    >
                      {v === null ? "—" : formatUnits(v, r.decimals)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-cream/50">Unavailable for these observations.</p>
      )}
    </div>
  );
}
function BinAllocation({
  snapshot: s,
  label,
}: {
  snapshot: SnapshotSummary | null;
  label: string;
}) {
  if (!s) return null;
  const max = (field: "x" | "y") =>
    s.bins.reduce((m, b) => (BigInt(b[field]) > m ? BigInt(b[field]) : m), 1n);
  const mx = max("x"),
    my = max("y");
  return (
    <div className="min-w-0 border border-line p-3">
      <p className="station-code text-[10px] text-cream/65">
        {label} · {s.bins.length} retained / {s.binCount} read
      </p>
      <div className="mt-3 overflow-x-auto">
        <div
          className="flex h-20 min-w-max items-end gap-1"
          role="img"
          aria-label={label + ": each token scaled independently"}
        >
          {s.bins.map((b) => (
            <div
              key={b.binId}
              title={"Bin " + b.binId + " · X " + b.x + " · Y " + b.y + " raw"}
              className="flex h-full w-3 items-end gap-px"
            >
              <span
                className="w-1.5 bg-amber"
                style={{ height: Number((BigInt(b.x) * 1000n) / mx) / 10 + "%" }}
              />
              <span
                className="w-1.5 bg-teal-300"
                style={{ height: Number((BigInt(b.y) * 1000n) / my) / 10 + "%" }}
              />
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[10px] text-cream/50">
        Amber X · teal Y · each token scaled independently. Hover for exact base units. Bin IDs are
        local to each pool.
      </p>
    </div>
  );
}

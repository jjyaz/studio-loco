import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Btn,
  Cap,
  Field,
  Notice,
  PageHead,
  Panel,
  Segmented,
  Spinner,
  Stat,
  btn,
} from "@/components/kit";
import { ReplayChart } from "@/components/app/ReplayChart";
import { DEFAULT_RULE, parseCommand } from "@/lib/agents";
import { JobControl } from "@/lib/job-control";
import { fetchPools } from "@/lib/meteora-api";
import { fetchReplayTape } from "@/lib/replay-data";
import { practiceReplayTape } from "@/lib/replay-practice";
import {
  replayExport,
  REPLAY_ASSUMPTIONS,
  runReplay,
  type ReplayConfig,
  type ReplayTape,
} from "@/lib/replay";
import { distribute, isPublicKey, TEMPLATES, type StrategyName } from "@/lib/strategy";
import { redactUrls, shortAddr } from "@/lib/format";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

export const Route = createFileRoute("/app/replay")({
  validateSearch: (search: Record<string, unknown>): { pool?: string } => ({
    pool:
      typeof search["pool"] === "string" && isPublicKey(search["pool"])
        ? search["pool"]
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "The Replay Room — Studio Loco" },
      {
        name: "description",
        content:
          "Replay liquidity-agent rules against completed historical Meteora candles. Inspect proposals, inferred range coverage and missing data without signing.",
      },
    ],
  }),
  component: function ReplayRoute() {
    const search = Route.useSearch();
    return <ReplayRoom initialPool={search.pool} />;
  },
});

const DEFAULT_COMMAND =
  "rebalance when out of range; alert me within 3 bins of the edge; cooldown 15 minutes";
const {
  v: _v,
  revision: _revision,
  armed: _armed,
  baseline: _baseline,
  ...DEFAULT_PARAMS
} = DEFAULT_RULE;
const TRIGGER_LABELS = {
  "out-time": "Out-of-range duration",
  volatility: "Volatility threshold",
  "left-range": "Range exit",
  "price-move": "Baseline price move",
  edge: "Range edge",
};
const priceText = (n: number) =>
  n >= 100 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(5) : n.toPrecision(5);
function strategyCommand(command: string, strategy: StrategyName) {
  return [
    ...command
      .split(/[;\n]+/)
      .map((s) => s.trim())
      .filter(
        (s) => s && !/^use (spot|curve|bid ?ask) (distribution|strategy|shape)[.!]?$/i.test(s),
      ),
    `use ${strategy.toLowerCase()} distribution`,
  ].join("; ");
}

export function ReplayRoom({ initialPool = "" }: { initialPool?: string }) {
  const [source, setSource] = useState<"historical" | "practice">("historical");
  const [address, setAddress] = useState(initialPool);
  const [window, setWindow] = useState<"day" | "week">("day");
  const [width, setWidth] = useState("21");
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [model, setModel] = useState(false);
  const [tape, setTape] = useState<ReplayTape | null>(null);
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctl] = useState(() => new JobControl());
  const [, redraw] = useState(0);
  const identity = `${source}|${address.trim()}|${window}`;
  const latest = useRef(identity);
  latest.current = identity;
  useEffect(() => {
    ctl.mounted = true;
    const unsub = ctl.subscribe(() => redraw((n) => n + 1));
    return () => {
      unsub();
      ctl.unmount();
    };
  }, [ctl]);
  useEffect(() => {
    ctl.invalidate();
    setTape(null);
    setPlaying(false);
    setSelected(0);
    setError(null);
  }, [identity, ctl]);
  useEffect(() => {
    setPlaying(false);
    setSelected(0);
  }, [width, command, model]);
  const parsed = useMemo(() => parseCommand(command), [command]);
  const widthNumber = Number(width);
  const widthError =
    !/^\d+$/.test(width) || !Number.isInteger(widthNumber) || widthNumber < 2 || widthNumber > 69
      ? "Choose 2–69 bins."
      : null;
  const config = useMemo<ReplayConfig | null>(
    () =>
      parsed.ok && !widthError
        ? {
            width: widthNumber,
            modelRebalances: model,
            rule: { ...DEFAULT_PARAMS, ...parsed.patch },
          }
        : null,
    [parsed, widthError, widthNumber, model],
  );
  const computed = useMemo(() => {
    if (!tape || !config) return { result: null, error: null };
    try {
      return { result: runReplay(tape, config), error: null };
    } catch (e) {
      return { result: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [tape, config]);
  const result = computed.result;
  const current = result?.points[selected] ?? result?.points[0];
  useEffect(() => {
    if (!playing || !result) return;
    const timer = setInterval(
      () => setSelected((i) => Math.min(i + 1, result.points.length - 1)),
      350,
    );
    const pause = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", pause);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", pause);
    };
  }, [playing, result]);
  useEffect(() => {
    if (result && selected >= result.points.length - 1) setPlaying(false);
  }, [selected, result]);

  async function load() {
    const job = ctl.begin();
    if (!job) return;
    const started = identity;
    setTape(null);
    setError(null);
    setPlaying(false);
    setSelected(0);
    try {
      const data =
        source === "practice"
          ? practiceReplayTape()
          : await job.step(
              fetchReplayTape(
                address.trim(),
                window === "day" ? "5m" : "1h",
                window === "day" ? 288 : 168,
                job.signal,
              ),
              45_000,
              "Loading historical tape",
            );
      job.check();
      if (latest.current === started) setTape(data);
    } catch (e) {
      if (job.alive() && latest.current === started)
        setError(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      ctl.end(job);
    }
  }
  async function findPool() {
    const job = ctl.begin();
    if (!job) return;
    const started = identity;
    setError(null);
    try {
      const data = await job.step(
        fetchPools(
          { page: 1, pageSize: 10, sort: "volume_24h", dir: "desc", hideBlacklisted: true },
          job.signal,
        ),
        40_000,
        "Finding an active mainnet pool",
      );
      const pool = data.data.find(
        (p) =>
          !p.is_blacklisted &&
          Number.isInteger(p.pool_config?.bin_step) &&
          p.token_x.decimals !== undefined &&
          p.token_y.decimals !== undefined,
      );
      if (!pool)
        throw new Error(
          "No pool with complete replay metadata was returned. Paste a pool address from the Terminal.",
        );
      job.check();
      if (latest.current === started) setAddress(pool.address);
    } catch (e) {
      if (job.alive() && latest.current === started)
        setError(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      ctl.end(job);
    }
  }
  function exportReport() {
    if (!tape || !config || !result) return;
    const url = URL.createObjectURL(
      new Blob([replayExport(tape, config, result)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `studio-loco-replay-${tape.source}-${tape.frame}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const comparisons = useMemo(
    () =>
      !tape || !config || !result
        ? []
        : TEMPLATES.map((template) => {
            const bins = template.below + template.above + 1;
            const report = runReplay(tape, {
              ...config,
              width: bins,
              rule: { ...config.rule, strategy: template.strategy },
            });
            return { template, bins, summary: report.summary };
          }),
    [tape, config, result],
  );

  return (
    <div>
      <div className="relative mb-6 overflow-hidden border border-line">
        <img
          src={nightAsset.url}
          alt="The Studio Loco night train under a cobalt sky"
          className="h-32 w-full object-cover object-center md:h-40"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-midnight/90 via-midnight/40 to-midnight/20" />
        <p className="absolute bottom-5 left-5 station-code text-amber">
          Recorded journeys. Better questions.
        </p>
      </div>
      <PageHead
        code="ST-08 · The Replay Room"
        title="Rewind the market."
        intro="Test the rules before the journey. Replay completed Meteora candles, inspect the agent’s decisions and compare modeled ranges. This room never signs or sends a transaction."
        cap={["simulation"]}
      />
      <div className="grid min-w-0 gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Panel>
            <h2 className="display text-2xl">Choose your tape.</h2>
            <div className="mt-4">
              <Segmented
                label="Replay data source"
                value={source}
                onChange={setSource}
                options={[
                  { value: "historical", label: "Historical · mainnet" },
                  { value: "practice", label: "Practice scenario" },
                ]}
              />
            </div>
            {source === "historical" ? (
              <div className="mt-5 space-y-4">
                <Field
                  label="Mainnet DLMM pool"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Paste pool address"
                  hint="The Data API is mainnet only. No wallet required."
                  error={
                    address.trim() && !isPublicKey(address.trim()) ? "Invalid pool address." : null
                  }
                />
                <Btn variant="line" size="sm" disabled={ctl.busy} onClick={findPool}>
                  Find an active pool
                </Btn>
                <Segmented
                  label="Historical window"
                  value={window}
                  onChange={setWindow}
                  options={[
                    { value: "day", label: "24h · 5m candles" },
                    { value: "week", label: "7d · 1h candles" },
                  ]}
                />
              </div>
            ) : (
              <p className="mt-4 text-sm text-cream/75">
                A fixed 8-hour synthetic market with a rising leg, reversal and two missing candles.
                Clearly labeled practice data; no historical results are substituted.
              </p>
            )}
            <Btn
              className="mt-5 w-full"
              onClick={load}
              disabled={ctl.busy || (source === "historical" && !isPublicKey(address.trim()))}
            >
              {source === "historical" ? "Load historical tape" : "Load practice tape"}
            </Btn>
            {ctl.busy && (
              <div className="mt-4">
                <Spinner
                  label={
                    ctl.draining && !ctl.running
                      ? "Waiting for the request to finish"
                      : "Loading market data"
                  }
                />
                <Btn variant="ghost" size="sm" onClick={() => ctl.invalidate()}>
                  Cancel loading
                </Btn>
              </div>
            )}
            <p className="mt-4 text-xs text-cream/60">
              API errors stay visible. Missing candles stay missing.
            </p>
          </Panel>
          <Panel>
            <h2 className="display text-2xl">Set the rules.</h2>
            <Field
              className="mt-4"
              label="Exact range width"
              inputMode="numeric"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              error={widthError}
              suffix="bins"
            />
            <label htmlFor="replay-command" className="station-code mt-5 block text-cream/80">
              Agent rule command
            </label>
            <textarea
              id="replay-command"
              rows={5}
              className="mt-2 w-full min-w-0 border border-input bg-midnight p-3 font-mono text-xs leading-relaxed text-cream focus:border-amber focus:outline-none"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              aria-invalid={!parsed.ok}
              aria-describedby="replay-rule-feedback"
            />
            <div id="replay-rule-feedback" className="mt-2 text-xs text-cream/70">
              {parsed.ok ? (
                <ul className="list-disc space-y-2 pl-4">
                  {parsed.summary.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : (
                <p role="alert" className="text-destructive">
                  {parsed.error}
                </p>
              )}
            </div>
            <p className="mt-3 text-xs text-cream/65">
              Unspecified rules retain the Observatory defaults: range-exit rebalance, 3-bin edge
              alert and 10-minute cooldown. Risk thresholds are off unless added.
            </p>
            <details className="mt-4 text-xs text-cream/75">
              <summary className="cursor-pointer py-2 text-amber">Add a risk rule</summary>
              <p className="mt-2">
                Add: “prepare a 50% withdrawal after 15 minutes out of range” or “prepare a 25%
                withdrawal if 5m volatility over 12 candles exceeds 1.5%”. The volatility frame must
                match the tape.
              </p>
            </details>
            <label className="mt-5 flex items-start gap-3 border-t border-line pt-4 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-amber"
                checked={model}
                onChange={(e) => setModel(e.target.checked)}
              />
              <span>
                Model proposed rebalances as approved
                <span className="mt-1 block text-xs text-cream/65">
                  Off by default. When on, a target frozen at one close applies before the next
                  observation. No wallet action occurs.
                </span>
              </span>
            </label>
          </Panel>
        </div>
        <div className="min-w-0 space-y-5">
          {(error || computed.error) && (
            <Notice tone="error" title="Replay stopped">
              {error ?? computed.error} Choose another pool, correct the rules or retry loading. No
              practice tape was substituted.
            </Notice>
          )}
          {!tape && !ctl.busy && !error && (
            <Panel tone="cobalt" className="flex min-h-72 flex-col justify-center">
              <p className="station-code text-amber">An observation deck for your strategy</p>
              <h2 className="display mt-4 text-3xl md:text-4xl">Every move leaves a trace.</h2>
              <p className="mt-4 max-w-lg text-cream/80">
                Load a historical tape or choose the practice scenario. Follow each completed close,
                see which rule wins, and learn how range width changes the decisions.
              </p>
              <p className="mt-5 text-sm text-cream/65">
                No fabricated returns. No wallet connection. Just transparent rules and visible
                assumptions.
              </p>
            </Panel>
          )}
          {tape && result && config && current && (
            <>
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="station-code text-amber">{tape.pool.name}</p>
                    <h2 className="display mt-2 text-2xl">A recorded journey.</h2>
                  </div>
                  <Cap kind={tape.source === "historical" ? "live" : "practice"} />
                </div>
                <p className="mt-3 break-words text-xs text-cream/65">
                  {tape.source === "historical"
                    ? `Historical API candles · ${shortAddr(tape.pool.address, 8)}`
                    : "Synthetic practice fixture"}{" "}
                  · {tape.frame} · bin step {tape.pool.binStep} · price in {tape.pool.symbolY} per{" "}
                  {tape.pool.symbolX}
                </p>
                <div className="my-6 grid grid-cols-2 gap-5 md:grid-cols-4">
                  <Stat
                    label="Close samples in range"
                    value={`${((result.summary.closesInRange / Math.max(1, result.summary.samples)) * 100).toFixed(1)}%`}
                    sub={`${result.summary.closesInRange} of ${result.summary.samples} observations`}
                  />
                  <Stat
                    label="Extrema outside range"
                    value={result.summary.candlesExtremaOutside}
                    sub="Intrabar order is unknown"
                  />
                  <Stat
                    label="New proposals"
                    value={result.summary.proposals}
                    sub={`${result.summary.riskProposals} risk · ${result.summary.rebalanceProposals} rebalance`}
                  />
                  <Stat
                    label="Modeled rebalances"
                    value={result.summary.modeledMoves}
                    sub={model ? "Hypothetical approvals enabled" : "Approvals not modeled"}
                  />
                </div>
                <ReplayChart tape={tape} result={result} selected={selected} />
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-cream/70">
                  <span className="text-amber">— Candle close</span>
                  <span className="text-[#91aaff]">■ Modeled range</span>
                  <span>● Rebalance proposal</span>
                  <span className="text-[#e87945]">● Risk proposal</span>
                  <span>UTC · gaps left blank</span>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Btn
                    size="sm"
                    variant="line"
                    onClick={() => {
                      if (selected >= result.points.length - 1) setSelected(0);
                      setPlaying((p) => !p);
                    }}
                  >
                    {playing ? "Pause replay" : "Play replay"}
                  </Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPlaying(false);
                      setSelected(0);
                    }}
                  >
                    Reset
                  </Btn>
                  <Btn size="sm" variant="ghost" onClick={exportReport}>
                    Export JSON report
                  </Btn>
                </div>
                <label
                  htmlFor="replay-observation"
                  className="station-code mt-4 block text-cream/75"
                >
                  Observation {selected + 1} of {result.points.length}
                </label>
                <input
                  id="replay-observation"
                  type="range"
                  min={0}
                  max={result.points.length - 1}
                  value={selected}
                  onChange={(e) => {
                    setPlaying(false);
                    setSelected(Number(e.target.value));
                  }}
                  className="mt-3 min-h-7 w-full accent-amber"
                  aria-valuetext={`Observation ${selected + 1}, ${new Date(current.candle.t * 1000 + (tape.frame === "5m" ? 300_000 : 3_600_000)).toISOString()}`}
                />
                <div className="mt-5 border-t border-line pt-4">
                  <p className="station-code text-amber">
                    {new Date(current.candle.t * 1000 + (tape.frame === "5m" ? 300_000 : 3_600_000))
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}{" "}
                    UTC · completed close
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                    <Stat label="Close price" value={priceText(current.candle.c)} />
                    <Stat label="Inferred bin" value={current.activeId} />
                    <Stat label="Modeled range" value={`${current.lower} → ${current.upper}`} />
                    <Stat
                      label="Observed out of range"
                      value={`${current.observedOutMin.toFixed(0)} min`}
                    />
                  </div>
                  <p className="mt-4 text-sm text-cream/80">
                    {current.bootstrap
                      ? "The first close initializes the range and baseline. No proposal is issued."
                      : current.proposal
                        ? `${current.proposal.kind === "reduce" ? `Prepare ${current.proposal.withdrawPct}% withdrawal` : "Propose rebalance"}: ${TRIGGER_LABELS[current.proposal.trigger]}. ${current.proposal.reason}`
                        : current.cooldownBlocked
                          ? `Highest trigger: ${TRIGGER_LABELS[current.triggers[0]!]} · cooldown blocks a repeated proposal.`
                          : "No rule trigger at this close."}
                  </p>
                  {current.modeledMove && (
                    <p className="mt-2 text-xs text-amber">
                      The previous close’s proposed range was applied hypothetically before this
                      observation.
                    </p>
                  )}
                  {current.gapBefore && (
                    <p className="mt-2 text-xs text-amber">
                      Missing period before this close. Observed duration restarted.
                    </p>
                  )}
                  {current.vol?.state === "unavailable" && (
                    <p className="mt-2 text-xs text-amber">
                      Volatility unavailable: {current.vol.reason}
                    </p>
                  )}
                  {current.vol?.state === "ok" && (
                    <p className="mt-2 text-xs text-cream/70">
                      Close-to-close volatility: {current.vol.pct.toFixed(3)}% over{" "}
                      {current.vol.candles} returns.
                    </p>
                  )}
                </div>
              </Panel>
              <Panel>
                <p className="station-code text-amber">Data quality</p>
                <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Stat
                    label="Completed candles"
                    value={`${tape.candles.length} / ${tape.quality.expectedBars}`}
                  />
                  <Stat label="Missing periods" value={tape.quality.missingBars} />
                  <Stat label="Internal gaps" value={tape.quality.gaps} />
                  <Stat label="Excluded boundary rows" value={tape.quality.excludedOutside} />
                </div>
                <p className="mt-4 text-xs text-cream/70">
                  Requested:{" "}
                  {new Date(tape.startSec * 1000).toISOString().slice(0, 16).replace("T", " ")} →{" "}
                  {new Date(tape.endSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.
                  Loaded {new Date(tape.loadedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.
                  Coverage uses completed close samples, not continuous time in range.
                </p>
                {result.summary.volatilityUnavailable > 0 && (
                  <p className="mt-2 text-xs text-amber">
                    Volatility was unavailable at {result.summary.volatilityUnavailable}{" "}
                    observations. Missing or mismatched history is never treated as low risk.
                  </p>
                )}
              </Panel>
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="station-code text-amber">Compare familiar routes</p>
                    <h2 className="display mt-2 text-2xl">Three widths. One tape.</h2>
                  </div>
                  <Cap kind="simulation" />
                </div>
                <p className="mt-3 text-sm text-cream/75">
                  Templates differ in width and distribution. Coverage comes from range geometry;
                  changing Spot, Curve or BidAsk at the same width does not create a different
                  coverage result. Shapes below are illustrative, not SDK fills.
                </p>
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  {comparisons.map(({ template, bins, summary }) => {
                    const weights = distribute(
                      template.strategy,
                      0,
                      -template.below,
                      template.above,
                    );
                    const max = Math.max(...weights.map((w) => w.x + w.y));
                    return (
                      <article
                        key={template.id}
                        className="min-w-0 border border-line bg-midnight p-4"
                      >
                        <p className="station-code text-amber">{template.name}</p>
                        <p className="mt-2 text-sm">
                          {template.strategy} · {bins} bins
                        </p>
                        <div
                          className="mt-4 flex h-12 items-end gap-px"
                          aria-label={`Illustrative ${template.strategy} distribution`}
                        >
                          {weights.map((w) => (
                            <span
                              key={w.binId}
                              className="min-w-0 flex-1 bg-amber/70"
                              style={{ height: `${Math.max(3, ((w.x + w.y) / max) * 100)}%` }}
                            />
                          ))}
                        </div>
                        <p className="mt-4 font-mono text-xl">
                          {((summary.closesInRange / Math.max(1, summary.samples)) * 100).toFixed(
                            1,
                          )}
                          %
                        </p>
                        <p className="text-xs text-cream/65">Close samples in range</p>
                        <p className="mt-3 text-xs text-cream/75">
                          {summary.proposals} proposals · {summary.modeledMoves} modeled moves
                        </p>
                        <Btn
                          className="mt-4 w-full"
                          size="sm"
                          variant="line"
                          onClick={() => {
                            setWidth(String(bins));
                            setCommand(strategyCommand(command, template.strategy));
                          }}
                        >
                          Apply {template.name}
                        </Btn>
                      </article>
                    );
                  })}
                </div>
              </Panel>
            </>
          )}
          <Panel>
            <p className="station-code text-amber">What this replay can tell you</p>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-sm text-cream/75">
              {REPLAY_ASSUMPTIONS.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link to="/app/agents" className={btn({ variant: "line", size: "sm" })}>
                Open The Observatory
              </Link>
              <Link to="/app/checks" className={btn({ variant: "ghost", size: "sm" })}>
                Rehearse your wallet
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

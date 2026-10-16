import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ShieldCheck, Layers, RefreshCw, Download } from "lucide-react";
import { Btn, Field, Panel, Notice, Spinner } from "@/components/kit";
import { useSettings } from "@/lib/settings";
import { useTxRunner, TxSteps } from "./useTx";
import { parseUnits, formatUnits } from "@/lib/amount";
import { shortAddr, explorerTx } from "@/lib/format";
import { JobControl, JobCancelled } from "@/lib/job-control";
import { subscribeConductor } from "@/lib/conductor-store";
import { type ConductorMission, exportMission } from "@/lib/conductor";
import { ExecutionBudget } from "../../../packages/sdk/src/ledger";
import { exportOperationLedger } from "../../../packages/sdk/src/ledger-evidence";
import {
  listLedger,
  sealBudget,
  summarize,
  MAX_OPERATIONS,
  type BudgetRow,
  type OperationRow,
} from "@/lib/ledger-store";
import {
  buildMissionAction,
  reserveMissionAction,
  recordMissionReview,
  missionPolicyGuard,
  rejectUnsignedOperation,
  reconcileMissionOperation,
  type BuiltMissionAction,
  type MissionActionInput,
} from "@/lib/conductor-execution";
import { redact } from "@/lib/recorder";

const token = (mint: string, side: string) =>
  mint === "So11111111111111111111111111111111111111112"
    ? "WSOL"
    : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : `Token ${side}`;
const units = (s: string, decimals: number) => {
  const n = parseUnits(s, decimals);
  if (!n.ok) throw new Error(n.error);
  return n.raw.toString();
};
const date = (t: number) => new Date(t).toLocaleString();
const message = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

export function ConductorOperations({ mission, now }: { mission: ConductorMission; now: number }) {
  const p = mission.policies.at(-1)!,
    s = p.policy.scope;
  const { connection } = useConnection(),
    wallet = useWallet(),
    { settings } = useSettings(),
    runner = useTxRunner();
  const ctl = useRef(new JobControl()).current;
  const live = useRef({ practice: settings.practice, cluster: settings.cluster });
  live.current = { practice: settings.practice, cluster: settings.cluster };
  const [ledger, setLedger] = useState<{ budgets: BudgetRow[]; operations: OperationRow[] } | null>(
    null,
  );
  const [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ x: "0", y: "0", sol: "0.02", hours: "24" });
  const [expected, setExpected] = useState<number | null>(null);
  const [input, setInput] = useState({
    action: "claim" as MissionActionInput["action"],
    bps: "25",
    strategy: "Spot" as MissionActionInput["strategy"],
    slippage: "50",
  });
  const [built, setBuilt] = useState<BuiltMissionAction | null>(null),
    [reading, setReading] = useState(false),
    [draining, setDraining] = useState(false);
  const generation = useRef(0),
    mounted = useRef(true);
  const sum = ledger ? summarize(ledger.budgets, ledger.operations, now) : null;
  const currentBudget = sum?.budget,
    staleBudget = !!currentBudget && currentBudget.policyDigest !== p.digest;
  const liveMode = !settings.practice && settings.cluster === "mainnet-beta";
  const matchingWallet = wallet.publicKey?.toBase58() === s.owner && runner.canSign;
  async function reload() {
    try {
      const l = await listLedger(mission.id);
      if (mounted.current) setLedger(l);
    } catch (e) {
      if (mounted.current) {
        setLedger(null);
        setError(message(e));
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    ctl.mounted = true;
    void reload();
    const off = subscribeConductor(() => void reload());
    const drain = ctl.subscribe(() => setDraining(ctl.draining));
    return () => {
      mounted.current = false;
      generation.current++;
      off();
      drain();
      ctl.unmount();
    };
  }, [mission.id]);
  useEffect(() => {
    generation.current++;
    ctl.invalidate();
    setBuilt(null);
  }, [
    p.digest,
    currentBudget?.revision,
    settings.cluster,
    settings.practice,
    settings.rpc[settings.cluster],
    wallet.publicKey?.toBase58(),
  ]);
  const invalidate = () => {
    generation.current++;
    ctl.invalidate();
    setBuilt(null);
    setError("");
    setInfo("");
  };
  function editBudget() {
    setExpected(currentBudget?.revision ?? null);
    setEditing(true);
    invalidate();
  }
  async function seal(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const hours = Number(form.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 720)
        throw new Error("Choose a lifetime from 1 to 720 hours.");
      await sealBudget(
        ExecutionBudget.parse({
          v: 1,
          kind: "cumulative-execution-budget",
          scope: {
            missionId: mission.id,
            owner: s.owner,
            cluster: "mainnet-beta",
            pool: s.pool,
            mintX: s.mintX,
            mintY: s.mintY,
          },
          revision: (expected ?? 0) + 1,
          policyDigest: p.digest,
          totalXRaw: units(form.x, s.decimalsX),
          totalYRaw: units(form.y, s.decimalsY),
          totalLamports: units(form.sol, 9),
          allowedActions: p.policy.allowedActions,
          expiresAt: Math.min(Date.now() + hours * 3600000, p.policy.expiresAt),
        }),
        expected,
      );
      setEditing(false);
      setInfo("Cumulative budget sealed. Prior spending and pending reservations remain counted.");
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    const job = ctl.begin();
    if (!job) return;
    const gen = generation.current;
    setReading(true);
    setBuilt(null);
    setError("");
    setInfo("");
    try {
      const bps = Number(units(input.bps, 2));
      const slippageBps = Number(input.slippage);
      if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 500)
        throw new Error("Choose 0–500 whole bps slippage.");
      const result = await buildMissionAction(
        connection,
        mission.id,
        { ...input, bps, slippageBps },
        job,
        settings.rpc[settings.cluster] ? "custom" : "relay",
      );
      if (gen === generation.current && mounted.current) setBuilt(result);
    } catch (e) {
      if (!(e instanceof JobCancelled) && gen === generation.current && mounted.current)
        setError(message(e));
    } finally {
      ctl.end(job);
      if (mounted.current) setReading(false);
    }
  }
  async function execute() {
    if (!built || !matchingWallet || !liveMode) return;
    const b = built,
      gen = generation.current;
    let row: OperationRow | undefined;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      row = await reserveMissionAction(b);
      await recordMissionReview(b, row);
      const cap = BigInt(p.policy.maxNetworkFeeLamports);
      const out = await runner.run([{ label: b.label, tx: b.tx }], {
        maxFeeLamports: Number(
          cap > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cap,
        ),
        semanticGuard: () =>
          generation.current === gen &&
          !live.current.practice &&
          live.current.cluster === "mainnet-beta" &&
          Date.now() <= b.expiresAt
            ? null
            : "Mission review expired, inputs or live mode changed. Rebuild.",
        policyGuard: missionPolicyGuard(connection, b, row, ctl),
        evidence: {
          title: `${mission.label} · ${b.action}`,
          links: { reviewId: row.id, proposalId: row.id },
          context: {
            missionId: mission.id,
            policyDigest: b.digest,
            budgetRevision: b.budgetRevision,
            instructionHash: b.instructionHash,
            operationId: row.id,
            journeyId: s.journeyId,
          },
        },
      });
      if (out[0]?.phase !== "confirmed")
        await rejectUnsignedOperation(
          mission.id,
          row.id,
          out[0]?.error ?? "Refused before broadcast",
        );
      setInfo(await reconcileMissionOperation(connection, mission.id, row.id));
    } catch (e) {
      if (row) await rejectUnsignedOperation(mission.id, row.id, message(e)).catch(() => {});
      setError(message(e));
    } finally {
      if (mounted.current) {
        setBuilt(null);
        setBusy(false);
        await reload();
      }
    }
  }
  async function reconcile(row: OperationRow, cancel = false) {
    setBusy(true);
    setError("");
    try {
      setInfo(
        cancel
          ? (await rejectUnsignedOperation(mission.id, row.id))
            ? "Unsigned review cancelled; reservation released."
            : "This action has a signature; check its chain status."
          : await reconcileMissionOperation(connection, mission.id, row.id),
      );
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!ledger) return;
    const text = JSON.stringify(
      exportOperationLedger(mission, ledger.budgets, ledger.operations),
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" })),
      a = document.createElement("a");
    a.href = url;
    a.download = `loco-operations-${mission.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const blocked = busy || reading || runner.running || draining;
  return (
    <section
      id="conductor-operations"
      className="scroll-mt-8 space-y-5"
      aria-label="Mission execution and operation ledger"
    >
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="station-code flex items-center gap-2 text-amber">
              <Layers size={16} />
              05 · Operation ledger
            </p>
            <h3 className="display mt-2 text-3xl">Capital has a memory.</h3>
          </div>
          <span className="station-code border border-amber/40 px-3 py-2 text-amber">
            LOCAL · WALLET APPROVED
          </span>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-cream/65">
          A separate cumulative budget counts confirmed spending and unresolved reservations across
          every budget revision. V1 token caps retain their per-operation meaning. These device
          rules are unsigned; they cannot control actions made elsewhere.
        </p>
        {error && (
          <div className="mt-4">
            <Notice tone="error" title="Operation unavailable">
              {error}
            </Notice>
          </div>
        )}
        {info && (
          <p
            role="status"
            className="mt-4 border border-line bg-midnight p-3 text-sm text-cream/80"
          >
            {info}
          </p>
        )}
        {!ledger && !error && <Spinner label="Opening durable operation ledger" />}
        {sum && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                {
                  label: token(s.mintX, "X"),
                  cap: sum.budget.totalXRaw,
                  dec: s.decimalsX,
                  key: "xRaw" as const,
                },
                {
                  label: token(s.mintY, "Y"),
                  cap: sum.budget.totalYRaw,
                  dec: s.decimalsY,
                  key: "yRaw" as const,
                },
                {
                  label: "SOL · fees + gross funding",
                  cap: sum.budget.totalLamports,
                  dec: 9,
                  key: "lamports" as const,
                },
              ].map((t) => (
                <div key={t.key} className="border border-line bg-midnight p-4">
                  <p className="station-code text-cream/60">{t.label}</p>
                  <p className="mt-3 font-mono text-2xl text-amber">
                    {formatUnits(sum.remaining[t.key], t.dec)}
                  </p>
                  <p className="mt-1 text-xs text-cream/50">
                    remaining · {formatUnits(t.cap, t.dec)} total
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3 text-xs">
                    <dt className="text-cream/60">Reserved</dt>
                    <dd className="text-right font-mono">
                      {formatUnits(sum.reserved[t.key], t.dec)}
                    </dd>
                    <dt className="text-cream/60">Consumed</dt>
                    <dd className="text-right font-mono">
                      {formatUnits(sum.consumed[t.key], t.dec)}
                    </dd>
                  </dl>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-cream/60">
              Budget v{sum.budget.revision} · expires {date(sum.budget.expiresAt)} ·{" "}
              {sum.unresolved} unresolved. SOL counts gross owner-funded account/rent transfers plus
              network fees. Refunds and token withdrawals do not automatically replenish budget.
            </p>
            {(sum.expired || staleBudget) && (
              <p className="mt-3 text-sm text-amber">
                {staleBudget
                  ? "Policy changed. Seal a matching budget revision before executing."
                  : "Execution budget expired. Seal a new revision."}
              </p>
            )}
          </>
        )}
        {ledger && !editing && (
          <Btn className="mt-5" variant="line" size="sm" disabled={blocked} onClick={editBudget}>
            {sum ? "Revise cumulative budget" : "Create cumulative budget"}
          </Btn>
        )}
        {editing && (
          <form onSubmit={seal} className="mt-5 space-y-4 border border-amber/35 bg-midnight p-4">
            <p className="station-code text-amber">
              Seal cumulative ceiling · revision {(expected ?? 0) + 1}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label={`Total ${token(s.mintX, "X")} top-ups`}
                value={form.x}
                onChange={(e) => setForm({ ...form, x: e.target.value })}
              />
              <Field
                label={`Total ${token(s.mintY, "Y")} top-ups`}
                value={form.y}
                onChange={(e) => setForm({ ...form, y: e.target.value })}
              />
              <Field
                label="Total SOL operating budget"
                value={form.sol}
                onChange={(e) => setForm({ ...form, sol: e.target.value })}
              />
              <Field
                label="Budget lifetime · hours"
                value={form.hours}
                onChange={(e) => setForm({ ...form, hours: e.target.value })}
              />
            </div>
            <p className="text-xs leading-5 text-cream/60">
              Expiry is capped by this mission policy. Current execution adapters use zero token
              top-up; token ceilings do not measure deployed LP inventory. Sealing uploads nothing
              and grants no signer.
            </p>
            <div className="flex gap-3">
              <Btn disabled={blocked || now >= p.policy.expiresAt} type="submit">
                Seal execution budget
              </Btn>
              <Btn disabled={busy} type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Btn>
            </div>
          </form>
        )}
      </Panel>
      <Panel>
        <p className="station-code flex items-center gap-2 text-amber">
          <ShieldCheck size={16} />
          06 · Verified execution desk
        </p>
        <h3 className="display mt-2 text-3xl">Review the action. Keep the rules.</h3>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Mission execution adapter support</caption>
            <thead className="station-code text-cream/50">
              <tr>
                <th className="pb-3">Action</th>
                <th className="pb-3">Supported boundary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr>
                <td className="py-3 text-success">Fee claim</td>
                <td>One position, one transaction; canonical owner token accounts.</td>
              </tr>
              <tr>
                <td className="py-3 text-success">Withdrawal</td>
                <td>One native range instruction; position remains open, WSOL stays wrapped.</td>
              </tr>
              <tr>
                <td className="py-3 text-success">Rebalance</td>
                <td>Atomic, zero token top-up; no reward-harvesting pools or staged setup.</td>
              </tr>
              <tr>
                <td className="py-3 text-cream/50">Other recipes</td>
                <td>
                  Token top-ups, closures, multi-stage moves, rewards, Zap and Pro are unsupported
                  here.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-5 text-cream/60">
          Every instruction, account role and recipient is checked against the installed IDL. Fresh
          simulation, fee/rent funding, reserve, expiry, cooldown, immutable policy and budget are
          checked before signing and after wallet approval. A wallet prompt taking longer than the
          20-second review window requires rebuilding.
        </p>
        {!s.position ? (
          <div className="mt-5">
            <Notice tone="info" title="Attach an LP through Journey">
              Pool-only missions observe depth. Create a mission from a retained Journey position to
              prepare native position actions.
            </Notice>
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="conductor-action" className="station-code text-cream/70">
                  Native mission action
                </label>
                <select
                  id="conductor-action"
                  className="mt-2 min-h-11 w-full border border-line bg-midnight px-3 text-sm"
                  value={input.action}
                  onChange={(e) => {
                    invalidate();
                    setInput({ ...input, action: e.target.value as MissionActionInput["action"] });
                  }}
                >
                  <option value="claim">Claim swap fees</option>
                  <option value="withdraw">Withdraw liquidity shares</option>
                  <option value="rebalance">Rebalance · zero top-up</option>
                </select>
              </div>
              {input.action === "withdraw" && (
                <Field
                  label="Withdraw liquidity shares · %"
                  value={input.bps}
                  onChange={(e) => {
                    invalidate();
                    setInput({ ...input, bps: e.target.value });
                  }}
                />
              )}
              {input.action === "rebalance" && (
                <>
                  <div>
                    <label htmlFor="conductor-strategy" className="station-code text-cream/70">
                      Same-width strategy
                    </label>
                    <select
                      id="conductor-strategy"
                      className="mt-2 min-h-11 w-full border border-line bg-midnight px-3 text-sm"
                      value={input.strategy}
                      onChange={(e) => {
                        invalidate();
                        setInput({
                          ...input,
                          strategy: e.target.value as MissionActionInput["strategy"],
                        });
                      }}
                    >
                      {["Spot", "Curve", "BidAsk"].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </div>
                  <Field
                    label="Slippage ceiling · bps"
                    value={input.slippage}
                    onChange={(e) => {
                      invalidate();
                      setInput({ ...input, slippage: e.target.value });
                    }}
                  />
                </>
              )}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Btn
                variant="line"
                disabled={blocked || !liveMode || !sum || sum.expired || staleBudget}
                onClick={() => void prepare()}
              >
                <RefreshCw size={15} />
                Prepare unsigned review
              </Btn>
              <p className="text-xs text-cream/60">
                Watch-only preparation is available. Signing requires owner {shortAddr(s.owner)}.
              </p>
            </div>
            {reading && (
              <Spinner label="Verifying scope, instructions, native costs and exact simulation" />
            )}
            {draining && !reading && (
              <p className="mt-3 text-sm text-amber">Waiting for a timed-out request to drain.</p>
            )}
            {built && (
              <div className="mt-5 border border-amber/50 bg-midnight p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="station-code text-amber">
                    {built.action} · independently inspected native instructions
                  </p>
                  <span
                    className={`station-code ${now > built.expiresAt ? "text-danger" : "text-success"}`}
                  >
                    {now > built.expiresAt
                      ? "Review expired"
                      : `${Math.max(0, Math.ceil((built.expiresAt - now) / 1000))}s to approve`}
                  </span>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="station-code text-cream/50">Reserved SOL needed</p>
                    <p className="mt-1 font-mono">
                      {formatUnits(String(built.costs.requiredLamports), 9)}
                    </p>
                  </div>
                  <div>
                    <p className="station-code text-cream/50">Network fee</p>
                    <p className="mt-1 font-mono">
                      {formatUnits(String(built.costs.feeLamports), 9)} SOL
                    </p>
                  </div>
                  <div>
                    <p className="station-code text-cream/50">Token top-up</p>
                    <p className="mt-1 font-mono">0 X · 0 Y</p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-cream/60">
                  Source bins {built.binding.source.lower}–{built.binding.source.upper}
                  {built.binding.target
                    ? ` → ${built.binding.target.lower}–${built.binding.target.upper}`
                    : ""}{" "}
                  · policy {built.digest.slice(0, 12)}… · budget v{built.budgetRevision}
                </p>
                <details className="mt-3 text-xs text-cream/60">
                  <summary className="cursor-pointer py-2">
                    Inspect instruction roles and fingerprint
                  </summary>
                  <p className="mt-2 break-all font-mono leading-5">
                    {built.instructionNames.join(" → ")}
                    <br />
                    {built.instructionHash}
                  </p>
                </details>
                <Btn
                  className="mt-4"
                  disabled={
                    blocked ||
                    !matchingWallet ||
                    !liveMode ||
                    now > built.expiresAt ||
                    BigInt(built.costs.requiredLamports!) > BigInt(sum?.remaining.lamports ?? "0")
                  }
                  onClick={() => void execute()}
                >
                  Reserve budget & approve in wallet
                </Btn>
                {!matchingWallet && (
                  <p className="mt-3 text-xs text-amber">
                    Connect the exact mission owner with a transaction-signing wallet to continue.
                  </p>
                )}
              </div>
            )}
          </>
        )}
        <div className="mt-4">
          <TxSteps steps={runner.steps} />
        </div>
      </Panel>
      {ledger && (
        <Panel>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <p className="station-code text-amber">
                Operation history · {ledger.operations.length}/{MAX_OPERATIONS}
              </p>
              <h3 className="display mt-2 text-2xl">From intent to evidence.</h3>
            </div>
            <Btn variant="ghost" size="sm" onClick={download}>
              <Download size={15} />
              Export operation evidence
            </Btn>
          </div>
          {!ledger.operations.length ? (
            <p className="mt-5 text-sm text-cream/60">
              No mission wallet actions recorded. Unsigned preparation does not reserve or spend
              capital.
            </p>
          ) : (
            <div className="mt-5 divide-y divide-line">
              {[...ledger.operations].reverse().map((row) => (
                <div key={row.id} className="py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="station-code text-amber">
                      {row.op.action} · {row.op.state}
                    </p>
                    <p className="font-mono text-xs text-cream/50">{row.id.slice(0, 22)}…</p>
                  </div>
                  <p className="mt-2 text-xs text-cream/60">
                    Budget v{row.op.budgetRevision} · reserved{" "}
                    {formatUnits(row.op.reserved.lamports, 9)} SOL
                    {row.op.consumed
                      ? ` · consumed ${formatUnits(row.op.consumed.lamports, 9)} SOL`
                      : ""}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-cream/65">
                    {row.op.evidence ?? "Local intent recorded."}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {row.op.instructionHash && (
                      <Link
                        className="text-xs text-amber underline"
                        to="/app/recorder"
                        search={{ id: row.id }}
                      >
                        Recorder review ↗
                      </Link>
                    )}
                    {row.op.signature && (
                      <a
                        className="text-xs text-amber underline"
                        href={explorerTx(row.op.signature, row.op.scope.cluster)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Chain receipt ↗
                      </a>
                    )}
                    {!["confirmed", "failed", "rejected", "expired"].includes(row.op.state) &&
                      (row.op.signature ? (
                        <Btn
                          disabled={busy || !liveMode}
                          size="sm"
                          variant="line"
                          onClick={() => void reconcile(row)}
                        >
                          Check chain status
                        </Btn>
                      ) : (
                        <Btn
                          disabled={busy}
                          size="sm"
                          variant="ghost"
                          onClick={() => void reconcile(row, true)}
                        >
                          Cancel unsigned review
                        </Btn>
                      ))}
                  </div>
                  <details className="mt-3 text-xs text-cream/60">
                    <summary className="cursor-pointer py-2">Retained lifecycle</summary>
                    {row.op.history.map((h, i) => (
                      <p key={i} className="mt-1 font-mono">
                        {date(h.at)} · {h.state}
                      </p>
                    ))}
                  </details>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs leading-5 text-cream/45">
            No automatic resend or timed release. Signed/submitted/unknown actions stay reserved
            until independently reconciled. At 200 operations or 20 budget revisions, new work
            stops; financial history is never silently truncated.
          </p>
        </Panel>
      )}
    </section>
  );
}

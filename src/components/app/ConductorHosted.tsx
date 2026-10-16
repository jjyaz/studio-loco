import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Cloud, Pause, Play, RefreshCw } from "lucide-react";
import { Btn, Panel, Notice, Spinner } from "@/components/kit";
import { AccountPanel, useCloudSession } from "@/components/signal/account";
import { type ConductorMission } from "@/lib/conductor";
import {
  listHostedMissions,
  getHostedMissionSamples,
  createHostedMission,
  changeHostedMission,
} from "@/lib/conductor-hosted.functions";
import { hostedSampleReport, type HostedMissionRow } from "@/lib/conductor-hosted";
import { shortAddr } from "@/lib/format";
import { redact } from "@/lib/recorder";

export function ConductorHosted({ mission, now }: { mission?: ConductorMission; now: number }) {
  const { session, userId, ready } = useCloudSession();
  const [connecting, setConnecting] = useState(false),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [info, setInfo] = useState("");
  const list = useServerFn(listHostedMissions),
    create = useServerFn(createHostedMission);
  const q = useQuery({
    queryKey: ["conductor-hosted", userId],
    enabled: !!session,
    queryFn: () => list(),
    refetchInterval: session ? 30_000 : false,
  });
  const copied = q.data?.missions.find((w) => w.rule.missionId === mission?.id);
  async function copy() {
    if (!mission || !consent) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const r = await create({
        data: {
          label: mission.label,
          config: {
            v: 1,
            kind: "loco-hosted-mission",
            missionId: mission.id,
            policy: mission.policies.at(-1)!,
          },
          consent: true,
        },
      });
      if (!r.ok) throw new Error(r.error);
      setInfo(
        "Private hosted copy saved. The existing five-minute scheduler will observe it while the page is closed.",
      );
      setConsent(false);
      await q.refetch();
    } catch (e) {
      setError(redact((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel tone="cobalt">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="station-code flex items-center gap-2 text-amber">
            <Cloud size={17} />
            07 · Hosted observation
          </p>
          <h2 className="display mt-2 text-3xl">The signal stays on.</h2>
        </div>
        <span className="station-code border border-cream/25 px-3 py-2">PRIVATE · READ ONLY</span>
      </div>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-cream/75">
        Opt in to an account-private copy of a mission. Signal Box samples it about every five
        minutes, including when this page is closed. Its worker observes public Solana accounts; it
        holds no wallet key and cannot prepare, reserve or execute a spending action.
      </p>
      {!ready && <Spinner label="Checking private workspace connection" />}
      {ready && !session && (
        <div className="mt-5">
          {!connecting ? (
            <Btn variant="line" onClick={() => setConnecting(true)}>
              Connect private workspace
            </Btn>
          ) : (
            <AccountPanel purpose="enable private hosted observation" />
          )}
          <p className="mt-3 text-xs leading-5 text-cream/60">
            Local missions and wallet reviews work independently. No mission is uploaded until you
            explicitly choose to copy it.
          </p>
        </div>
      )}
      {session && (
        <>
          {q.isPending ? (
            <Spinner label="Reading your private hosted missions" />
          ) : q.isError ? (
            <div className="mt-4">
              <Notice tone="error" title="Hosted workspace unavailable">
                {redact((q.error as Error).message)}
                <Btn size="sm" variant="ghost" onClick={() => void q.refetch()}>
                  Retry
                </Btn>
              </Notice>
            </div>
          ) : (
            <>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-cream/20 py-3 text-xs text-cream/70">
                <span>
                  Shared Signal Box limit: five watches per account · last 60 observations per
                  mission retained
                </span>
                <Btn variant="ghost" size="sm" onClick={() => void q.refetch()}>
                  <RefreshCw size={14} />
                  Refresh
                </Btn>
              </div>
              <p className="mt-3 text-xs text-cream/65">
                Scheduler heartbeat:{" "}
                {q.data?.tick?.finished_at
                  ? new Date(q.data.tick.finished_at).toLocaleString()
                  : "not observed yet"}
                . A heartbeat does not guarantee every watch ran in that tick; overdue missions
                remain waiting or stale.
              </p>
              {mission && !copied && (
                <div className="mt-5 border border-amber/40 bg-midnight/65 p-4">
                  <p className="station-code text-amber">
                    Copy {mission.label} · policy v{mission.policies.at(-1)!.revision}
                  </p>
                  <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm leading-6 text-cream/75">
                    <input
                      className="mt-1 size-4 accent-amber"
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Store this mission’s pool/owner/position addresses, policy, trade sizes and
                    public-chain observations—including observed balances—in my private Studio Loco
                    account.
                  </label>
                  <Btn
                    className="mt-4"
                    disabled={!consent || busy || now >= mission.policies.at(-1)!.policy.expiresAt}
                    onClick={() => void copy()}
                  >
                    Enable hosted observation
                  </Btn>
                </div>
              )}
              {!q.data?.missions.length && (
                <p className="mt-5 text-sm text-cream/75">
                  No hosted missions yet. Select a local mission and explicitly copy its policy to
                  start.
                </p>
              )}
              <div className="mt-5 space-y-4">
                {q.data?.missions.map((w) => (
                  <HostedCard
                    key={w.id}
                    row={w}
                    mission={mission?.id === w.rule.missionId ? mission : undefined}
                    now={now}
                    onChange={() => q.refetch()}
                  />
                ))}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-danger">
              {error}
            </p>
          )}
          {info && (
            <p role="status" className="mt-4 text-sm text-cream">
              {info}
            </p>
          )}
        </>
      )}
      <p className="mt-5 text-xs leading-5 text-cream/60">
        These are scheduled samples, not continuous coverage. Your 30–150-second policy freshness
        window may expire between five-minute ticks. Hosted copies never become local signing
        authority, and private history is not exposed through public MCP. Pausing preserves history;
        removing a hosted copy removes its private observations.
      </p>
    </Panel>
  );
}
function HostedCard({
  row: w,
  mission,
  now,
  onChange,
}: {
  row: HostedMissionRow;
  mission?: ConductorMission;
  now: number;
  onChange(): unknown;
}) {
  const [open, setOpen] = useState(false),
    [removing, setRemoving] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useServerFn(getHostedMissionSamples),
    change = useServerFn(changeHostedMission);
  const q = useQuery({
    queryKey: ["conductor-hosted-samples", w.id, w.revision],
    enabled: open,
    queryFn: () => load({ data: { id: w.id } }),
    refetchInterval: open ? 30_000 : false,
  });
  const p = w.rule.policy,
    expired = now >= Date.parse(w.expires_at),
    newer = !!mission && mission.policies.at(-1)!.revision > p.revision;
  async function act(action: "pause" | "resume" | "revise" | "remove") {
    setBusy(true);
    setError("");
    try {
      const r = await change({
        data: {
          id: w.id,
          revision: w.revision,
          action,
          ...(action === "revise" && mission
            ? {
                config: {
                  v: 1 as const,
                  kind: "loco-hosted-mission" as const,
                  missionId: mission.id,
                  policy: mission.policies.at(-1)!,
                },
              }
            : {}),
        },
      });
      if (!r.ok) throw new Error(r.error);
      setRemoving(false);
      onChange();
    } catch (e) {
      setError(redact((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="border border-cream/25 bg-midnight/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="display text-xl">{w.label}</h3>
        <span className="station-code text-amber">
          {expired ? "expired" : w.status} · hosted r{w.revision}
        </span>
      </div>
      <p className="mt-2 text-xs text-cream/70">
        Policy v{p.revision} · {p.digest.slice(0, 12)}… · pool {shortAddr(p.policy.scope.pool)} ·
        expires {new Date(w.expires_at).toLocaleString()}
      </p>
      <p className="mt-2 text-xs text-cream/65">
        Last attempt:{" "}
        {w.last_run_at ? new Date(w.last_run_at).toLocaleString() : "waiting for scheduler"} ·{" "}
        {w.out_run?.count ?? 0} retained + omitted attempts.
      </p>
      {w.last_error && (
        <p className="mt-3 text-sm text-amber">
          Latest read unavailable: {w.last_error}. Previous successful samples are historical.
        </p>
      )}
      {newer && (
        <p className="mt-3 text-xs text-amber">
          Your local mission has a newer policy. The hosted copy keeps its own revision until you
          explicitly update it.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn
          variant="line"
          size="sm"
          disabled={busy || expired}
          onClick={() => void act(w.status === "active" ? "pause" : "resume")}
        >
          {w.status === "active" ? <Pause size={14} /> : <Play size={14} />}{" "}
          {w.status === "active" ? "Pause hosted" : "Resume hosted"}
        </Btn>
        <Btn variant="line" size="sm" disabled={busy || !newer} onClick={() => void act("revise")}>
          Copy newer local policy
        </Btn>
        <Btn variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide history" : "View private history"}
        </Btn>
        {!removing ? (
          <Btn variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(true)}>
            Remove hosted copy
          </Btn>
        ) : (
          <>
            <Btn variant="danger" size="sm" disabled={busy} onClick={() => void act("remove")}>
              Confirm removal & delete private history
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setRemoving(false)}>
              Keep it
            </Btn>
          </>
        )}
      </div>
      {expired && (
        <p className="mt-3 text-xs text-cream/65">
          Seal a fresh local policy, copy that newer revision, then explicitly resume.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {open && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          {q.isPending ? (
            <Spinner label="Reading private sample evidence" />
          ) : q.isError ? (
            <p role="alert" className="text-sm text-danger">
              Private evidence unavailable.
            </p>
          ) : (
            <>
              <p className="text-xs text-cream/60">
                {q.data?.length ?? 0} retained ·{" "}
                {Math.max(0, (w.out_run?.count ?? 0) - (q.data?.length ?? 0))} older attempts
                omitted · observation gaps are retained as attempts.
              </p>
              {!q.data?.length && (
                <p className="text-sm text-cream/65">No committed samples yet.</p>
              )}
              {q.data?.map((r, i) => {
                const report = hostedSampleReport(r.sample, now),
                  currentPolicy = r.sample.policy.digest === w.rule.policy.digest;
                return (
                  <details key={r.id} className="border border-line p-3">
                    <summary className="cursor-pointer text-xs leading-6">
                      <span className="station-code text-amber">
                        {new Date(r.observedAt).toLocaleString()} · {report.recordedState} when
                        sampled
                      </span>
                      <span className="ml-3 text-cream/70">
                        policy v{r.sample.policy.revision}
                        {i === 0
                          ? ` · now: ${currentPolicy ? report.state : "waiting for current-policy sample"}`
                          : ""}
                      </span>
                    </summary>
                    <p className="mt-2 text-xs text-cream/70">{report.detail}</p>
                    <pre className="mt-3 max-h-72 overflow-auto text-[11px] leading-5 text-cream/65">
                      {JSON.stringify(r.sample, null, 2)}
                    </pre>
                  </details>
                );
              })}
            </>
          )}
        </div>
      )}
    </article>
  );
}

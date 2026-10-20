import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Btn, Field, Notice, Panel, Segmented, Spinner, Stat } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { useSettings } from "@/lib/settings";
import { parseUnits } from "@/lib/amount";
import { recordFact } from "@/lib/recorder-store";
import { cn } from "@/lib/utils";
import {
  DEPOT_REVIEW_TTL_MS,
  LAUNCH_PRESETS,
  bindingKey,
  getPreset,
  launchMath,
  type Recipient,
  type ReviewBinding,
} from "@/lib/depot";
import { GATE_MAX_AGE_S, IMAGE_MIMES, MAX_IMAGE_BYTES, isAddress32, type AgentDTO, type ScoutReportDTO, type TokenMetadataDTO } from "@/lib/depot-contracts";
import {
  createAgent,
  deleteAgent,
  listMyAgents,
  listMyReports,
  listMyTokenMetadata,
  publishTokenMetadata,
  recordVerifiedLaunch,
  runScoutReport,
  setPassportPublished,
  updateAgent,
} from "@/lib/depot.functions";
import type { DepotLifecycle, DepotTarget, PreparedDepotAction } from "@/lib/depot-chain";
import type { DepotOperation } from "@/lib/depot-operations";
import type { TxStep } from "@/lib/tx";
import { Addr, Copy, ScoutReportView, WalletProof, fmtRaw, useCountdown, useRpcGeneration } from "./shared";

const LAUNCH_META_KEY = "studio-loco:depot-launch-meta:v1";
type LaunchMeta = Record<string, { metadataDigest: string; presetId: string; presetVersion: number }>;
const readLaunchMeta = (): LaunchMeta => {
  try {
    return JSON.parse(localStorage.getItem(LAUNCH_META_KEY) ?? "{}") as LaunchMeta;
  } catch {
    return {};
  }
};

export function DepotWorkspace({ userId }: { userId: string }) {
  const list = useServerFn(listMyAgents);
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ["depot", "agents", userId], queryFn: () => list() });
  const [selected, setSelected] = useState<string | null>(null);
  const rows = agents.data?.ok ? agents.data.agents : [];
  const agent = rows.find((a) => a.id === selected) ?? rows[0] ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ["depot", "agents", userId] });
  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <aside className="flex flex-col gap-4">
        <Panel>
          <p className="station-code text-amber">Platform 1 · Your agents</p>
          {agents.isLoading && <div className="mt-3"><Spinner label="Loading agents" /></div>}
          {agents.data && !agents.data.ok && <div className="mt-3"><Notice tone="error" title="Agents unavailable">{agents.data.error}</Notice></div>}
          {agents.isError && <div className="mt-3"><Notice tone="error" title="Agents unavailable">Could not reach the workspace.</Notice></div>}
          {agents.data?.ok && rows.length === 0 && <p className="mt-3 text-sm text-cream/75">No agents yet. Create a Scout to start.</p>}
          <ul className="mt-3 flex flex-col gap-1">
            {rows.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setSelected(a.id)}
                  aria-current={agent?.id === a.id}
                  className={cn("w-full border px-3 py-2 text-left transition-colors", agent?.id === a.id ? "border-amber bg-muted" : "border-line hover:bg-muted")}
                >
                  <span className="block font-medium text-cream">{a.name}</span>
                  <span className="station-code text-cream/60">
                    {a.visibility === "public" ? "Published" : "Private"} · {a.walletVerifiedAt ? "wallet proven" : "wallet unproven"}
                    {a.launch ? " · token linked" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <CreateAgent onCreated={(id) => { void refresh(); setSelected(id); }} />
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        {agent ? <AgentStation key={agent.id} agent={agent} refresh={refresh} onDeleted={() => { setSelected(null); void refresh(); }} /> : null}
      </div>
    </div>
  );
}

function CreateAgent({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useServerFn(createAgent);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Panel tone="cobalt">
      <p className="station-code text-amber">New Scout agent</p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await create({ data: { name, description, mission: "scout" } });
            if (!r.ok) throw new Error(r.error);
            setName("");
            setDescription("");
            onCreated(r.agent.id);
          } catch (x) {
            setErr(x instanceof Error ? x.message : String(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
        <label className="flex flex-col gap-1.5">
          <span className="station-code text-cream/80">Service mission</span>
          <textarea
            value={description}
            maxLength={600}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this Scout reports on, and for whom."
            className="border border-input bg-midnight px-3 py-2 text-sm text-cream outline-none focus:border-amber"
          />
        </label>
        {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
        <Btn type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create private draft"}</Btn>
      </form>
    </Panel>
  );
}

type Tab = "passport" | "launch" | "scout" | "fees";

function AgentStation({ agent, refresh, onDeleted }: { agent: AgentDTO; refresh: () => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<Tab>("passport");
  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="station-code text-amber">Passport · rev {agent.revision}</p>
            <h2 className="display mt-1 text-3xl">{agent.name}</h2>
            <p className="mt-1 max-w-2xl text-sm text-cream/75">{agent.description || "No service mission described yet."}</p>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <span className={cn("station-code border px-2 py-1", agent.visibility === "public" ? "border-success text-success" : "border-cream/50 text-cream/75")}>
              {agent.visibility === "public" ? "Published passport" : "Private draft"}
            </span>
            <span className="station-code text-cream/60">Mission · Scout</span>
          </div>
        </div>
        <div className="mt-4">
          <Segmented<Tab>
            label="Agent workspace"
            value={tab}
            onChange={setTab}
            options={[
              { value: "passport", label: "Passport" },
              { value: "launch", label: "Token launch" },
              { value: "scout", label: "Scout" },
              { value: "fees", label: "Fee desk · ops" },
            ]}
          />
        </div>
      </Panel>
      {tab === "passport" && <PassportPanel agent={agent} refresh={refresh} onDeleted={onDeleted} />}
      {tab === "launch" && <LaunchPanel agent={agent} refresh={refresh} />}
      {tab === "scout" && <ScoutPanel agent={agent} />}
      {tab === "fees" && <FeeDesk agent={agent} refresh={refresh} />}
    </>
  );
}

/* ---------------- Passport ---------------- */

function PassportPanel({ agent, refresh, onDeleted }: { agent: AgentDTO; refresh: () => void; onDeleted: () => void }) {
  const upd = useServerFn(updateAgent);
  const pub = useServerFn(setPassportPublished);
  const del = useServerFn(deleteAgent);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [policy, setPolicy] = useState(agent.reportPolicy);
  const [gateMint, setGateMint] = useState(agent.gateMint ?? "");
  const [gateMin, setGateMin] = useState(agent.gateMinRaw ?? "");
  const [gateAge, setGateAge] = useState(String(Math.min(agent.gateMaxAgeS, GATE_MAX_AGE_S)));
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");
  const [busy, setBusy] = useState(false);
  const link = typeof window !== "undefined" ? `${window.location.origin}/depot/${agent.id}` : `/depot/${agent.id}`;
  async function act(f: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await f();
      if (!r.ok) throw new Error(r.error ?? "Failed");
      setMsg({ tone: "info", text: ok });
      refresh();
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  const gateErr =
    policy === "token-holders"
      ? !isAddress32(gateMint) ? "Enter a valid mint address" : !/^[1-9]\d{0,19}$/.test(gateMin) ? "Enter a positive raw integer" : null
      : null;
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Panel>
        <p className="station-code text-amber">Controller wallet</p>
        {agent.walletVerifiedAt ? (
          <div className="mt-2 text-sm">
            <p>Proven controller: <Addr a={agent.wallet} label="controller wallet" /></p>
            <p className="mt-1 text-xs text-cream/60">Verified {new Date(agent.walletVerifiedAt).toLocaleString()}. {agent.launch ? "Bound to the verified launch; a new controller needs a new agent." : "Proving another wallet replaces it."}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-cream/75">No wallet proven. Publishing, launching and holder-only reports need a signed wallet proof.</p>
        )}
        <div className="mt-4 flex flex-col gap-3">
          <WalletButton />
          <WalletProof agentId={agent.id} purpose="controller" onVerified={refresh} disabledReason={agent.launch ? "Launch-bound: controller is fixed." : null} />
        </div>
      </Panel>
      <Panel>
        <p className="station-code text-amber">Publication</p>
        <p className="mt-2 text-sm text-cream/75">
          A published passport shows only name, mission, proven wallet, report policy, verified launch identity and metadata
          versions. Private drafts are never readable by anyone else.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            disabled={busy || (agent.visibility === "private" && !agent.walletVerifiedAt)}
            onClick={() => act(() => pub({ data: { id: agent.id, revision: agent.revision, publish: agent.visibility === "private" } }), agent.visibility === "private" ? "Passport published." : "Passport unpublished.")}
            variant={agent.visibility === "public" ? "line" : "primary"}
          >
            {agent.visibility === "public" ? "Unpublish" : "Publish passport"}
          </Btn>
          {agent.visibility === "public" && (
            <span className="inline-flex items-center gap-1 text-sm">
              <Link to="/depot/$id" params={{ id: agent.id }} className="font-mono underline underline-offset-4 hover:text-amber">/depot/{agent.id.slice(0, 8)}…</Link>
              <Copy text={link} label="public passport link" />
            </span>
          )}
        </div>
      </Panel>
      <Panel>
        <p className="station-code text-amber">Details</p>
        <div className="mt-3 flex flex-col gap-3">
          <Field label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <label className="flex flex-col gap-1.5">
            <span className="station-code text-cream/80">Service mission</span>
            <textarea value={description} maxLength={600} rows={3} onChange={(e) => setDescription(e.target.value)} className="border border-input bg-midnight px-3 py-2 text-sm text-cream outline-none focus:border-amber" />
          </label>
          <Btn disabled={busy || !name.trim()} onClick={() => act(() => upd({ data: { id: agent.id, revision: agent.revision, name, description } }), "Saved.")}>Save details</Btn>
        </div>
      </Panel>
      <Panel>
        <p className="station-code text-amber">Report access</p>
        <div className="mt-3 flex flex-col gap-3">
          <Segmented label="Report policy" value={policy} onChange={setPolicy} options={[{ value: "public", label: "Public reports" }, { value: "token-holders", label: "Token holders" }]} />
          {policy === "token-holders" && (
            <>
              <Field label="Gate mint" value={gateMint} onChange={(e) => setGateMint(e.target.value.trim())} hint="Any SPL / Token-2022 mint, often this agent's own token." />
              <Field label="Minimum balance (raw units)" inputMode="numeric" value={gateMin} onChange={(e) => setGateMin(e.target.value.trim())} hint="Exact integer in the mint's smallest unit. For 6 decimals, 1 token = 1000000." />
              <Field label={`Balance freshness (s, ≤${GATE_MAX_AGE_S})`} inputMode="numeric" value={gateAge} onChange={(e) => setGateAge(e.target.value)} />
            </>
          )}
          {gateErr && <p className="text-xs text-destructive" role="alert">{gateErr}</p>}
          <p className="text-xs text-cream/60">Holder reports are checked on the server against a fresh confirmed balance of a wallet the viewer proved they control. Nothing is delivered to the browser before that check.</p>
          <Btn
            disabled={busy || !!gateErr || (policy === "token-holders" && !agent.walletVerifiedAt)}
            onClick={() =>
              act(
                () =>
                  upd({
                    data: {
                      id: agent.id,
                      revision: agent.revision,
                      reportPolicy: policy,
                      ...(policy === "token-holders" ? { gateMint, gateMinRaw: gateMin, gateMaxAgeS: Math.max(10, Math.min(GATE_MAX_AGE_S, Number(gateAge) || GATE_MAX_AGE_S)) } : {}),
                    },
                  }),
                "Access policy saved.",
              )
            }
          >
            Save access policy
          </Btn>
        </div>
      </Panel>
      {msg && <div className="xl:col-span-2"><Notice tone={msg.tone} title={msg.text} /></div>}
      <Panel className="xl:col-span-2">
        <p className="station-code text-destructive">Delete agent</p>
        <p className="mt-2 text-sm text-cream/75">Removes the passport and its reports. Published token metadata stays immutable and resolvable, and nothing onchain changes.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label={`Type ${agent.name} to confirm`} value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
          <Btn variant="danger" disabled={busy || confirmDelete !== agent.name} onClick={() => act(async () => { const r = await del({ data: { id: agent.id, revision: agent.revision } }); if (r.ok) onDeleted(); return r; }, "Agent deleted.")}>
            Delete permanently
          </Btn>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- shared action runner ---------------- */

function useDepotOperations(agentId: string) {
  const [ops, setOps] = useState<DepotOperation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      import("@/lib/depot-operations")
        .then((m) => m.listDepotOperations(agentId))
        .then((r) => { if (alive) { setOps(r); setErr(null); } }, (e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    void load();
    window.addEventListener("studio-loco:depot", load);
    return () => { alive = false; window.removeEventListener("studio-loco:depot", load); };
  }, [agentId]);
  const blocking = ops?.find((o) => ["reserved", "pending", "unknown", "confirmed"].includes(o.state)) ?? null;
  return { ops, err, blocking };
}

function useBinding(agent: AgentDTO, extra: { presetId: string; presetVersion: number; metadataUri: string; metadataHash?: string; maxStageLamports: bigint; maxTotalLamports: bigint }) {
  const wallet = useWallet();
  const { settings } = useSettings();
  const gen = useRpcGeneration();
  const pk = wallet.publicKey?.toBase58() ?? "";
  const recipients: Recipient[] = pk ? (["payer", "creator", "fee-claimer", "leftover-receiver", "locked-lp-owner"] as const).map((role) => ({ role, address: pk })) : [];
  const binding: ReviewBinding = {
    wallet: pk,
    cluster: settings.cluster,
    rpc: settings.rpc[settings.cluster] ? "custom" : "relay",
    rpcGeneration: gen,
    agentId: agent.id,
    agentRevision: agent.revision,
    ...extra,
    recipients,
  };
  const ref = useRef(binding);
  ref.current = binding;
  const blocker =
    settings.practice ? "Practice mode is on. The Depot only runs against live mainnet." :
    settings.cluster !== "mainnet-beta" ? "Switch to Mainnet. Depot launches and receipts are mainnet-only in this release." :
    !pk ? "Connect the agent's wallet." :
    !agent.walletVerifiedAt || agent.wallet !== pk ? "The connected wallet must be this agent's proven controller." :
    !wallet.signTransaction ? "This wallet cannot return signed transactions for verification." : null;
  return { binding, ref, blocker };
}

function ActionReview({ prepared, onExpire }: { prepared: PreparedDepotAction; onExpire: () => void }) {
  const left = useCountdown(prepared.review.createdAt, DEPOT_REVIEW_TTL_MS);
  useEffect(() => { if (left === 0) onExpire(); }, [left, onExpire]);
  const s = prepared.review.stages[0]!;
  const total = (s.feeLamports ?? 0n) + (s.rentLamports ?? 0n);
  return (
    <div className="border border-amber p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="station-code text-amber">Review · {prepared.label}</p>
        <p className={cn("station-code", (left ?? 0) <= 5 ? "text-destructive" : "text-cream/75")}>Expires in {left}s</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Stat label="Network fee" value={`${fmtRaw(String(s.feeLamports), 9)} SOL`} sub={`${s.feeLamports} lamports`} />
        <Stat label="New accounts + spend" value={`${fmtRaw(String(s.rentLamports), 9)} SOL`} sub={`${s.rentLamports} lamports`} />
        <Stat label="Total" value={`${fmtRaw(String(total), 9)} SOL`} sub={`cap ${fmtRaw(String(prepared.binding.maxStageLamports), 9)} SOL`} />
        <Stat label="Read slot" value={prepared.observedSlot} sub={`${prepared.signers.length} in-memory signer(s)`} />
      </div>
      <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
        <div><dt className="station-code text-cream/60">Config</dt><dd><Addr a={prepared.target.config} label="config" /></dd></div>
        <div><dt className="station-code text-cream/60">Mint</dt><dd><Addr a={prepared.target.mint} label="mint" /></dd></div>
        <div><dt className="station-code text-cream/60">DBC pool</dt><dd><Addr a={prepared.target.pool} label="pool" /></dd></div>
        {prepared.target.dammPool && <div><dt className="station-code text-cream/60">DAMM v2 pool</dt><dd><Addr a={prepared.target.dammPool} label="DAMM pool" /></dd></div>}
      </dl>
      <div className="mt-3">
        <p className="station-code text-cream/60">Every economic role</p>
        <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
          {prepared.binding.recipients.map((r) => <li key={r.role}><span className="station-code text-cream/70">{r.role}</span> <Addr a={r.address} label={r.role} /></li>)}
        </ul>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-cream/75">{prepared.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}

/** One reviewed, guarded, ledgered action. Never retried automatically. */
function useDepotAction(agent: AgentDTO, bindingRef: React.MutableRefObject<ReviewBinding>, opts: { recheck?: (p: PreparedDepotAction) => Promise<string | null> } = {}) {
  const { connection } = useConnection();
  const tx = useTxRunner();
  const list = useServerFn(listMyAgents);
  const [prepared, setPrepared] = useState<PreparedDepotAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<TxStep[] | null>(null);
  const key = bindingKey(bindingRef.current);
  useEffect(() => { if (prepared && prepared.review.key !== key) { setPrepared(null); setError("Inputs, wallet, network or RPC changed. Prepare a fresh review."); } }, [key, prepared]);
  async function prepare(f: () => Promise<PreparedDepotAction>) {
    setBusy(true); setError(null); setSteps(null); setPrepared(null);
    try {
      const p = await f();
      setPrepared(p);
      void recordFact({ kind: "review", title: `Depot review · ${p.label}`, route: "/app/depot", cluster: p.binding.cluster, wallet: p.binding.wallet, context: { depotAgent: agent.id, depotKind: p.kind, mint: p.target.mint, pool: p.target.pool, config: p.target.config, slot: p.observedSlot } }).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function approve(onConfirmed?: (opId: string, p: PreparedDepotAction) => void) {
    const p = prepared;
    if (!p) return;
    setBusy(true); setError(null);
    const { depotPolicyGuard, settleDepotOperation } = await import("@/lib/depot-operations");
    let opId: string | undefined;
    let out: TxStep[] | undefined;
    try {
      const guard = depotPolicyGuard({ connection, prepared: p, current: () => bindingRef.current, reserved: (id) => { opId = id; } });
      out = await tx.run([{ label: p.label, tx: p.tx, signers: p.signers }], {
        maxFeeLamports: Number(p.review.stages[0]!.feeLamports),
        policyGuard: guard,
        semanticGuard: () => (bindingKey(bindingRef.current) !== p.review.key ? "Inputs changed since review." : Date.now() - p.review.createdAt > DEPOT_REVIEW_TTL_MS ? "Review expired; prepare again." : null),
        asyncSemanticGuard: async () => {
          const r = await list();
          if (!r.ok) return "Could not re-read the agent; nothing signed.";
          const a = r.agents.find((x) => x.id === p.binding.agentId);
          if (!a || a.revision !== p.binding.agentRevision || a.wallet !== p.binding.wallet || !a.walletVerifiedAt) return "Agent revision or proven wallet changed. Prepare again.";
          return opts.recheck ? await opts.recheck(p) : null;
        },
        evidence: { title: `Depot · ${p.label}`, context: { depotAgent: agent.id, depotKind: p.kind, mint: p.target.mint, pool: p.target.pool, config: p.target.config } },
      });
      setSteps(out);
      if (opId && out[0]?.phase === "confirmed") onConfirmed?.(opId, p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (opId) await settleDepotOperation(opId, out?.[0]).catch((e) => setError(`Ledger update failed: ${e instanceof Error ? e.message : e}`));
      setPrepared(null);
      setBusy(false);
    }
  }
  return { prepared, setPrepared, busy, error, setError, steps, prepare, approve, running: tx.running };
}

/* ---------------- Token launch ---------------- */

const SOL = 1_000_000_000n;

function LaunchPanel({ agent, refresh }: { agent: AgentDTO; refresh: () => void }) {
  const listMeta = useServerFn(listMyTokenMetadata);
  const publishMeta = useServerFn(publishTokenMetadata);
  const meta = useQuery({ queryKey: ["depot", "meta", agent.id], queryFn: () => listMeta({ data: { agentId: agent.id } }) });
  const versions = meta.data?.ok ? meta.data.metadata : [];
  const [digest, setDigest] = useState<string | null>(null);
  const chosen: TokenMetadataDTO | null = versions.find((m) => m.digest === digest) ?? null;
  const [presetId, setPresetId] = useState(LAUNCH_PRESETS[0]!.id);
  const preset = getPreset(presetId, 1);
  const math = launchMath(preset);
  const [capSol, setCapSol] = useState("0.1");
  const cap = parseUnits(capSol, 9);
  const capLamports = cap.ok ? BigInt(cap.raw.toString()) : 0n;
  const { connection } = useConnection();
  const { binding, ref, blocker } = useBinding(agent, { presetId, presetVersion: 1, metadataUri: chosen?.uri ?? "", metadataHash: chosen?.digest, maxStageLamports: capLamports, maxTotalLamports: capLamports });
  const ops = useDepotOperations(agent.id);
  const action = useDepotAction(agent, ref, {
    recheck: async (p) => {
      const { verifyDepotMetadata } = await import("@/lib/depot-chain");
      if (!chosen) return "Metadata selection changed.";
      try {
        await verifyDepotMetadata({ name: chosen.name, symbol: chosen.symbol, description: chosen.description, imageUrl: chosen.imageUri, metadataUri: chosen.uri }, new URL(chosen.uri).origin, p.metadataHash ?? "");
        return null;
      } catch (e) {
        return `Published metadata check failed: ${e instanceof Error ? e.message : e}`;
      }
    },
  });
  const disabled = blocker ?? (agent.launch ? "This agent already has a verified launch." : !chosen ? "Select or publish token metadata." : !cap.ok || capLamports <= 0n ? "Enter a positive SOL cap." : ops.blocking ? "Resolve the open Depot operation in Fee desk · ops first." : null);
  return (
    <div className="flex flex-col gap-6">
      <MetadataPublisher agent={agent} publish={publishMeta} onPublished={(d) => { void meta.refetch(); setDigest(d); }} />
      <Panel>
        <p className="station-code text-amber">Published metadata versions</p>
        {meta.isLoading && <Spinner label="Loading metadata" />}
        {meta.data && !meta.data.ok && <Notice tone="error" title="Metadata unavailable">{meta.data.error}</Notice>}
        {meta.data?.ok && versions.length === 0 && <p className="mt-2 text-sm text-cream/75">Nothing published yet.</p>}
        <ul className="mt-3 grid gap-2">
          {versions.map((m) => (
            <li key={m.digest}>
              <label className={cn("flex cursor-pointer flex-wrap items-center gap-3 border p-3", digest === m.digest ? "border-amber bg-muted" : "border-line")}>
                <input type="radio" name="meta" checked={digest === m.digest} onChange={() => setDigest(m.digest)} className="accent-amber" />
                <img src={m.imageUri} alt={`${m.symbol} token image`} className="size-12 border border-line object-cover" loading="lazy" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{m.name} · {m.symbol} · v{m.version}</span>
                  <span className="block break-all font-mono text-xs text-cream/65">{m.uri}</span>
                  <span className="block font-mono text-xs text-cream/50">sha256 {m.digest}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel>
        <p className="station-code text-amber">Launch preset · DBC → DAMM v2</p>
        <div className="mt-3"><Segmented label="Preset" value={presetId} onChange={setPresetId} options={LAUNCH_PRESETS.map((p) => ({ value: p.id, label: p.label }))} /></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Fixed supply" value={fmtRaw(math.rawSupply.toString(), preset.tokenDecimals)} sub={`${math.rawSupply} raw · ${preset.tokenDecimals} dp`} />
          <Stat label="Nominal curve / migration" value="80% / 20%" sub="Nominal. Exact amounts derived by the Meteora SDK and migration rounding." />
          <Stat label="Graduation threshold" value={`${fmtRaw(preset.migrationQuoteThresholdRaw.toString(), 9)} SOL`} sub={`${preset.migrationQuoteThresholdRaw} lamports`} />
          <Stat label="Curve trading fee" value="1%" sub="Meteora protocol 20% · owner 80% · no Studio Loco fee" />
          <Stat label="Migrated LP" value="100% permanently locked" sub="Owner position can still claim eligible DAMM fees" />
          <Stat label="After graduation" value="DAMM v2 · 1% tier" sub="Separate DAMM v2 fee schedule" />
        </div>
        <p className="mt-3 text-xs text-cream/65">Mint and freeze authority are removed (immutable fixed supply). No initial purchase, transfer tax or hidden recipient. Graduation is to DAMM v2 only — never DLMM or Pro.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Max SOL for this transaction (fee + new accounts)" value={capSol} onChange={(e) => setCapSol(e.target.value)} suffix="SOL" error={cap.ok ? null : cap.error} />
        </div>
        <div className="mt-4">
          <p className="station-code text-cream/60">Recipients (all must be your proven wallet)</p>
          <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
            {binding.recipients.length ? binding.recipients.map((r) => <li key={r.role}><span className="station-code text-cream/70">{r.role}</span> <Addr a={r.address} label={r.role} /></li>) : <li className="text-cream/65">Connect the wallet to list recipients.</li>}
          </ul>
        </div>
      </Panel>
      <Panel tone="cobalt">
        <p className="station-code text-amber">Step 3 · Review, simulate, sign</p>
        {disabled && <p className="mt-2 text-sm text-cream/80">{disabled}</p>}
        <div className="mt-3 flex flex-wrap gap-3">
          <Btn
            disabled={!!disabled || action.busy}
            onClick={() =>
              action.prepare(async () => {
                const { prepareDepotLaunch } = await import("@/lib/depot-chain");
                const m = chosen!;
                return prepareDepotLaunch(connection, ref.current, { name: m.name, symbol: m.symbol, description: m.description, imageUrl: m.imageUri, metadataUri: m.uri }, new URL(m.uri).origin);
              })
            }
          >
            {action.busy && !action.prepared ? "Simulating…" : "Prepare fresh launch review"}
          </Btn>
          {action.prepared && (
            <Btn variant="primary" disabled={action.busy || action.running || !!disabled} onClick={() => action.approve((opId, p) => {
              const all = readLaunchMeta();
              all[opId] = { metadataDigest: p.metadataHash!, presetId: p.binding.presetId, presetVersion: p.binding.presetVersion };
              localStorage.setItem(LAUNCH_META_KEY, JSON.stringify(all));
            })}>
              Approve in wallet
            </Btn>
          )}
        </div>
        {action.prepared && <div className="mt-4"><ActionReview prepared={action.prepared} onExpire={() => { action.setPrepared(null); action.setError("Review expired after 20 seconds. Prepare again."); }} /></div>}
        {action.error && <div className="mt-3"><Notice tone="error" title="Not signed">{action.error}</Notice></div>}
        {action.steps && <div className="mt-3"><TxSteps steps={action.steps} /></div>}
        <p className="mt-3 text-xs text-cream/60">Confirmation is not verification. After confirming, open Fee desk · ops to verify the receipt and link the launch to this passport.</p>
      </Panel>
      <OperationsList agent={agent} ops={ops} refresh={refresh} />
    </div>
  );
}

function MetadataPublisher({ agent, publish, onPublished }: { agent: AgentDTO; publish: ReturnType<typeof useServerFn<typeof publishTokenMetadata>>; onPublished: (digest: string) => void }) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const nameBytes = new TextEncoder().encode(name).length;
  const errs = [
    !name.trim() || nameBytes > 32 ? `Name 1–32 bytes (${nameBytes})` : null,
    !/^[A-Z0-9]{1,10}$/.test(symbol) ? "Symbol 1–10 uppercase letters/digits" : null,
    description.length > 500 ? "Description ≤ 500 characters" : null,
    !file ? "Choose an image" : !(IMAGE_MIMES as readonly string[]).includes(file.type) ? "PNG, JPEG or WebP only" : file.size > MAX_IMAGE_BYTES ? "Image ≤ 256 KB" : null,
    !consent ? "Confirm immutability" : null,
  ].filter(Boolean) as string[];
  return (
    <Panel>
      <p className="station-code text-amber">Step 1 · Immutable token metadata</p>
      {!agent.walletVerifiedAt && <p className="mt-2 text-sm text-cream/75">Prove the controller wallet in Passport first.</p>}
      <form
        className="mt-3 grid gap-3 md:grid-cols-[1fr_160px]"
        onSubmit={async (e) => {
          e.preventDefault();
          if (errs.length || !file) return;
          setBusy(true); setMsg(null);
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            const r = await publish({ data: { agentId: agent.id, name, symbol, description, imageBase64: btoa(bin), imageMime: file.type as (typeof IMAGE_MIMES)[number], confirmImmutable: true } });
            if (!r.ok) throw new Error(r.error);
            setMsg({ tone: "info", text: r.reused ? `Identical content already published as v${r.version}.` : `Published v${r.version}.` });
            void recordFact({ kind: "proposal", title: `Depot metadata v${r.version}`, route: "/app/depot", cluster: "mainnet-beta", context: { depotAgent: agent.id, metadataDigest: r.digest, metadataUri: r.uri } }).catch(() => {});
            onPublished(r.digest);
          } catch (x) {
            setMsg({ tone: "error", text: x instanceof Error ? x.message : String(x) });
          } finally { setBusy(false); }
        }}
      >
        <div className="flex flex-col gap-3">
          <Field label="Token name" value={name} onChange={(e) => setName(e.target.value)} hint={`${nameBytes}/32 bytes`} />
          <Field label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))} />
          <label className="flex flex-col gap-1.5">
            <span className="station-code text-cream/80">Description ({description.length}/500)</span>
            <textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} className="border border-input bg-midnight px-3 py-2 text-sm text-cream outline-none focus:border-amber" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="station-code text-cream/80">Image (PNG/JPEG/WebP, ≤256 KB)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-cream file:mr-3 file:border file:border-cream/60 file:bg-transparent file:px-3 file:py-2 file:text-cream" />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 accent-amber" />
            <span>I understand this name, symbol, description and image become a permanent public, hash-addressed file that cannot be edited or deleted. Changes create a new version.</span>
          </label>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-40 items-center justify-center border border-line bg-midnight">
            {preview ? <img src={preview} alt="Selected token image preview" className="size-full object-cover" /> : <span className="station-code text-cream/50">No image</span>}
          </div>
        </div>
        <div className="md:col-span-2 flex flex-col gap-2">
          {errs.length > 0 && <p className="text-xs text-cream/65">{errs.join(" · ")}</p>}
          <Btn type="submit" disabled={busy || errs.length > 0 || !agent.walletVerifiedAt}>{busy ? "Publishing…" : "Publish immutable metadata"}</Btn>
          <p className="text-xs text-cream/60">Free to publish; no onchain cost until a launch uses the URI. Must be published from the public site (not localhost).</p>
          {msg && <Notice tone={msg.tone} title={msg.text} />}
        </div>
      </form>
    </Panel>
  );
}

/* ---------------- Operations ---------------- */

function OperationsList({ agent, ops, refresh }: { agent: AgentDTO; ops: ReturnType<typeof useDepotOperations>; refresh: () => void }) {
  const { connection } = useConnection();
  const record = useServerFn(recordVerifiedLaunch);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  async function act(id: string, f: () => Promise<void>, ok: string) {
    setBusy(id); setMsg(null);
    try { await f(); setMsg({ tone: "info", text: ok }); }
    catch (e) { setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  }
  return (
    <Panel>
      <p className="station-code text-amber">Depot operations · this device</p>
      <p className="mt-1 text-xs text-cream/60">Stored durably in this browser. Signed or unknown operations block new actions until reconciled read-only; nothing is ever resent.</p>
      {ops.err && <div className="mt-2"><Notice tone="error" title="Operation ledger unavailable — signing blocked">{ops.err}</Notice></div>}
      {ops.ops === null && !ops.err && <div className="mt-2"><Spinner label="Reading ledger" /></div>}
      {ops.ops?.length === 0 && <p className="mt-2 text-sm text-cream/70">No Depot operations on this device.</p>}
      <ul className="mt-3 flex flex-col gap-2">
        {ops.ops?.map((o) => (
          <li key={o.id} className="border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{o.label}</span>
              <span className={cn("station-code border px-2 py-0.5", o.state === "verified" ? "border-success text-success" : ["failed", "expired", "cancelled"].includes(o.state) ? "border-cream/40 text-cream/70" : "border-amber text-amber")}>{o.state}</span>
            </div>
            <p className="mt-1 font-mono text-xs text-cream/60">{new Date(o.createdAt).toLocaleString()} · {o.pending ? <a className="underline" href={`https://solscan.io/tx/${o.pending.signature}`} target="_blank" rel="noreferrer">{o.pending.signature.slice(0, 16)}…</a> : "unsigned"}</p>
            {o.error && <p className="mt-1 text-xs text-destructive">{o.error}</p>}
            {o.verification && <p className="mt-1 text-xs text-cream/70">{o.verification}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {(o.state === "pending" || o.state === "unknown") && (
                <Btn size="sm" variant="line" disabled={!!busy} onClick={() => act(o.id, async () => { const m = await import("@/lib/depot-operations"); await m.reconcileDepotOperation(connection, o); }, "Status re-read.")}>Check status (read-only)</Btn>
              )}
              {o.state === "reserved" && !o.pending && (
                <Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => act(o.id, async () => { const m = await import("@/lib/depot-operations"); await m.releaseUnsignedDepotOperation(o.id); }, "Unsigned reservation released.")}>Release unsigned reservation</Btn>
              )}
              {o.state === "confirmed" && (
                <Btn size="sm" disabled={!!busy} onClick={() => act(o.id, async () => {
                  const m = await import("@/lib/depot-operations");
                  await m.verifyDepotOperation(connection, o);
                  if (o.kind === "launch") {
                    const meta = readLaunchMeta()[o.id];
                    if (!meta) throw new Error("Receipt verified on this device, but the reviewed metadata/preset identifiers are missing here; cannot link.");
                    const r = await record({ data: { agentId: agent.id, revision: agent.revision, config: o.target.config, mint: o.target.mint, pool: o.target.pool, signature: o.pending!.signature, ...meta } });
                    if (!r.ok) throw new Error(`Receipt verified; linking failed: ${r.error}`);
                    void recordFact({ kind: "wallet-action", title: "Depot launch verified + linked", route: "/app/depot", cluster: "mainnet-beta", wallet: o.wallet, context: { depotAgent: agent.id, mint: o.target.mint, pool: o.target.pool, signature: o.pending!.signature } }).catch(() => {});
                    refresh();
                  }
                }, "Verified.")}>
                  Verify receipt{o.kind === "launch" ? " + link launch" : ""}
                </Btn>
              )}
              {o.state === "verified" && o.kind === "launch" && !agent.launch && (
                <Btn size="sm" variant="line" disabled={!!busy} onClick={() => act(o.id, async () => {
                  const meta = readLaunchMeta()[o.id];
                  if (!meta) throw new Error("Reviewed metadata/preset identifiers are missing on this device.");
                  const r = await record({ data: { agentId: agent.id, revision: agent.revision, config: o.target.config, mint: o.target.mint, pool: o.target.pool, signature: o.pending!.signature, ...meta } });
                  if (!r.ok) throw new Error(r.error);
                  refresh();
                }, "Launch linked.")}>Link verified launch</Btn>
              )}
            </div>
          </li>
        ))}
      </ul>
      {msg && <div className="mt-2"><Notice tone={msg.tone} title={msg.text} /></div>}
    </Panel>
  );
}

/* ---------------- Fee desk ---------------- */

function FeeDesk({ agent, refresh }: { agent: AgentDTO; refresh: () => void }) {
  const { connection } = useConnection();
  const [capSol, setCapSol] = useState("0.05");
  const cap = parseUnits(capSol, 9);
  const capLamports = cap.ok ? BigInt(cap.raw.toString()) : 0n;
  const launch = agent.launch;
  const { ref, blocker } = useBinding(agent, { presetId: launch?.presetId ?? "standard-sol-85", presetVersion: launch?.presetVersion ?? 1, metadataUri: "", maxStageLamports: capLamports, maxTotalLamports: capLamports });
  const ops = useDepotOperations(agent.id);
  const action = useDepotAction(agent, ref);
  const [life, setLife] = useState<DepotLifecycle | null>(null);
  const [lifeErr, setLifeErr] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [reserveTo, setReserveTo] = useState("");
  const [reserveSol, setReserveSol] = useState("");
  const target: DepotTarget | null = launch ? { config: launch.config, mint: launch.mint, pool: launch.pool } : null;
  async function read() {
    if (!target || !agent.wallet) return;
    setReading(true); setLifeErr(null);
    try { const m = await import("@/lib/depot-chain"); setLife(await m.readDepotLifecycle(connection, target, agent.wallet, "mainnet-beta")); }
    catch (e) { setLife(null); setLifeErr(e instanceof Error ? e.message : String(e)); }
    finally { setReading(false); }
  }
  const disabled = blocker ?? (!cap.ok || capLamports <= 0n ? "Enter a positive SOL cap." : ops.blocking ? "Resolve the open operation below first." : null);
  const reserveAmt = parseUnits(reserveSol || "0", 9);
  const pct = life ? Number((BigInt(life.quoteReserveRaw) * 10000n) / (BigInt(life.thresholdRaw) || 1n)) / 100 : 0;
  return (
    <div className="flex flex-col gap-6">
      {!launch ? (
        <Panel><Notice title="No verified launch linked">Launch a token from the Token launch tab, confirm it in your wallet, then verify and link the receipt below. Lifecycle, fees and graduation appear only for a server-verified launch.</Notice></Panel>
      ) : (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="station-code text-amber">Lifecycle · DBC → DAMM v2</p>
            <Btn size="sm" variant="line" onClick={read} disabled={reading}>{reading ? "Reading chain…" : life ? "Refresh" : "Read lifecycle"}</Btn>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="station-code text-cream/60">Mint</dt><dd><Addr a={launch.mint} label="mint" /></dd></div>
            <div><dt className="station-code text-cream/60">DBC pool</dt><dd><Addr a={launch.pool} label="pool" /></dd></div>
            <div><dt className="station-code text-cream/60">Launch receipt</dt><dd><a className="font-mono underline" href={`https://solscan.io/tx/${launch.signature}`} target="_blank" rel="noreferrer">{launch.signature.slice(0, 12)}…</a> · slot {launch.slot}</dd></div>
          </dl>
          {lifeErr && <div className="mt-3"><Notice tone="error" title="Lifecycle unavailable">{lifeErr}</Notice></div>}
          {life && (
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <div className="flex justify-between text-sm"><span className="station-code">{life.status}</span><span className="font-mono">{fmtRaw(life.quoteReserveRaw, 9)} / {fmtRaw(life.thresholdRaw, 9)} SOL</span></div>
                <div className="mt-1 h-3 border border-line bg-midnight" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label="Bonding reserve toward graduation threshold">
                  <div className="h-full bg-amber" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <p className="mt-1 text-xs text-cream/60">Read at slot {life.slot}, {new Date(life.readAt).toLocaleTimeString()}. A snapshot, not continuous monitoring.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat label="Creator curve fees · token" value={fmtRaw(life.creatorBaseFeeRaw, 6)} sub={`${life.creatorBaseFeeRaw} raw`} />
                <Stat label="Creator curve fees · SOL (as WSOL)" value={fmtRaw(life.creatorQuoteFeeRaw, 9)} sub={`${life.creatorQuoteFeeRaw} lamports`} />
              </div>
              {life.target.dammPool && <p className="text-sm">DAMM v2 pool: <Addr a={life.target.dammPool} label="DAMM pool" /> {life.status === "graduated" ? "(verified owner-program + token pair)" : "(derived; not yet created)"}</p>}
              {life.dammPositions.map((p) => (
                <div key={p.address} className="border border-line p-3 text-sm">
                  <p>Position <Addr a={p.address} label="position" /></p>
                  <p className="mt-1 font-mono text-xs">Locked liquidity {p.permanentLockedLiquidity} · unlocked {p.unlockedLiquidity}</p>
                  <p className="font-mono text-xs">Pending fees: token {fmtRaw(p.feeARaw, 6)} · SOL {fmtRaw(p.feeBRaw, 9)}</p>
                  <Btn size="sm" className="mt-2" disabled={!!disabled || action.busy} onClick={() => action.prepare(async () => (await import("@/lib/depot-chain")).prepareDepotDammClaim(connection, ref.current, target!, p.address))}>Prepare DAMM fee claim</Btn>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Btn disabled={!!disabled || action.busy || life.status !== "ready-to-graduate"} onClick={() => action.prepare(async () => (await import("@/lib/depot-chain")).prepareDepotMigration(connection, ref.current, target!))}>Prepare graduation</Btn>
                <Btn variant="line" disabled={!!disabled || action.busy || BigInt(life.creatorBaseFeeRaw) + BigInt(life.creatorQuoteFeeRaw) === 0n} onClick={() => action.prepare(async () => (await import("@/lib/depot-chain")).prepareDepotCurveClaim(connection, ref.current, target!))}>Prepare curve fee claim</Btn>
              </div>
            </div>
          )}
        </Panel>
      )}
      {launch && (
        <Panel>
          <p className="station-code text-amber">Operating reserve · explicit SOL transfer</p>
          <p className="mt-1 text-xs text-cream/65">A separately reviewed transfer from your wallet's SOL balance. It does not spend claimed WSOL automatically and does not prove who controls the receiving wallet.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Reserve wallet" value={reserveTo} onChange={(e) => setReserveTo(e.target.value.trim())} error={reserveTo && !isAddress32(reserveTo) ? "Invalid address" : null} />
            <Field label="Amount" value={reserveSol} onChange={(e) => setReserveSol(e.target.value)} suffix="SOL" error={reserveSol && !reserveAmt.ok ? reserveAmt.error : null} />
          </div>
          <Btn className="mt-3" disabled={!!disabled || action.busy || !isAddress32(reserveTo) || !reserveAmt.ok || reserveAmt.raw.isZero()} onClick={() => action.prepare(async () => (await import("@/lib/depot-chain")).prepareDepotReserve(connection, ref.current, target!, reserveTo, BigInt(reserveAmt.ok ? reserveAmt.raw.toString() : "0")))}>Prepare reserve transfer</Btn>
        </Panel>
      )}
      <Panel tone="cobalt">
        <Field label="Max SOL per action (fee + new accounts + transfer)" value={capSol} onChange={(e) => setCapSol(e.target.value)} suffix="SOL" error={cap.ok ? null : cap.error} />
        {disabled && launch && <p className="mt-2 text-sm text-cream/80">{disabled}</p>}
        {action.prepared && (
          <div className="mt-4 flex flex-col gap-3">
            <ActionReview prepared={action.prepared} onExpire={() => { action.setPrepared(null); action.setError("Review expired after 20 seconds. Prepare again."); }} />
            <Btn disabled={action.busy || action.running || !!disabled} onClick={() => action.approve(() => void read())}>Approve in wallet</Btn>
          </div>
        )}
        {action.busy && !action.prepared && <div className="mt-3"><Spinner label="Reading and simulating" /></div>}
        {action.error && <div className="mt-3"><Notice tone="error" title="Not signed">{action.error}</Notice></div>}
        {action.steps && <div className="mt-3"><TxSteps steps={action.steps} /></div>}
      </Panel>
      <OperationsList agent={agent} ops={ops} refresh={refresh} />
    </div>
  );
}

/* ---------------- Scout ---------------- */

const SOL_USDC = { pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", x: "100000000", y: "10000000" };

function ScoutPanel({ agent }: { agent: AgentDTO }) {
  const run = useServerFn(runScoutReport);
  const listR = useServerFn(listMyReports);
  const reports = useQuery({ queryKey: ["depot", "reports", agent.id], queryFn: () => listR({ data: { agentId: agent.id } }) });
  const [pool, setPool] = useState("");
  const [px, setPx] = useState("");
  const [py, setPy] = useState("");
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [latest, setLatest] = useState<ScoutReportDTO | null>(null);
  const parse = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  const valid = isAddress32(pool) && [parse(px), parse(py)].every((a) => a.length >= 1 && a.length <= 3 && a.every((n) => /^[1-9]\d{0,19}$/.test(n)));
  const history = useMemo(() => (reports.data?.ok ? reports.data.reports : []), [reports.data]);
  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <p className="station-code text-amber">Scout · read-only market probe</p>
        <p className="mt-1 text-sm text-cream/75">The server reads the pool, bins and quotes directly from mainnet using Studio Loco's verified adapter. Probes are exact raw units (the token's smallest unit). Nothing is signed.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field className="md:col-span-3" label="DLMM pool address" value={pool} onChange={(e) => setPool(e.target.value.trim())} error={pool && !isAddress32(pool) ? "Invalid address" : null} />
          <Field label="Token X probes (raw, up to 3 increasing)" value={px} onChange={(e) => setPx(e.target.value)} />
          <Field label="Token Y probes (raw, up to 3 increasing)" value={py} onChange={(e) => setPy(e.target.value)} />
          <label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} className="accent-amber" /> Add AI commentary (5/hour)</label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn disabled={!valid || busy} onClick={async () => {
            setBusy(true); setErr(null);
            try {
              const r = await run({ data: { agentId: agent.id, pool, probesX: parse(px), probesY: parse(py), withAi: ai } });
              if (!r.ok) throw new Error(r.error);
              setLatest(r.report);
              void recordFact({ kind: "proposal", title: `Scout report · slot ${r.report.facts.slot}`, route: "/app/depot", cluster: "mainnet-beta", context: { depotAgent: agent.id, reportId: r.report.id, pool: r.report.facts.pool, slot: r.report.facts.slot } }).catch(() => {});
              void reports.refetch();
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(false); }
          }}>{busy ? "Reading mainnet…" : "Run Scout report"}</Btn>
          <Btn variant="ghost" onClick={() => { setPool(SOL_USDC.pool); setPx(SOL_USDC.x); setPy(SOL_USDC.y); }}>Use SOL–USDC pool (0.1 SOL · 10 USDC)</Btn>
        </div>
        {err && <div className="mt-3"><Notice tone="error" title="No report">{err}</Notice></div>}
      </Panel>
      {latest && <ScoutReportView r={latest} />}
      <Panel>
        <p className="station-code text-amber">Report history</p>
        {reports.isLoading && <Spinner label="Loading reports" />}
        {reports.data?.ok && history.length === 0 && <p className="mt-2 text-sm text-cream/70">No reports yet.</p>}
        <div className="mt-3 flex flex-col gap-3">{history.filter((r) => r.id !== latest?.id).slice(0, 5).map((r) => <ScoutReportView key={r.id} r={r} />)}</div>
      </Panel>
    </div>
  );
}

export const _SOL = SOL;

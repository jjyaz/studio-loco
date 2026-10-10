import { createFileRoute, Link } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowRight,
  Check,
  Download,
  Fingerprint,
  Layers3,
  Plus,
  Radio,
  ShieldCheck,
  Upload,
  Waypoints,
} from "lucide-react";
import { Btn, Field, Notice, Panel, Segmented, Spinner, Stat } from "@/components/kit";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { WalletButton } from "@/components/wallet/WalletButton";
import { useSettings } from "@/lib/settings";
import { fetchPools } from "@/lib/meteora-api";
import { shortAddr, redactUrls } from "@/lib/format";
import { JobCancelled, JobControl } from "@/lib/job-control";
import { browserPendingStore } from "@/lib/tx";
import { recordFact, listRecords, subscribeRecorder } from "@/lib/recorder-store";
import type { FlightRecord } from "@/lib/recorder";
import {
  listBlueprints,
  saveBlueprint,
  subscribeFoundry,
  type SavedBlueprint,
} from "@/lib/foundry-store";
import {
  readFoundryPool,
  buildFoundryAction,
  revalidateFoundryAction,
  type FoundryBuild,
  type FoundryPoolSnapshot,
} from "@/lib/foundry-chain";
import {
  BlueprintSchema,
  canonicalBlueprint,
  compileBlueprint,
  draftBlueprint,
  foundryBins,
  foundryReviewReason,
  FOUNDRY_REVIEW_TTL,
  MAX_BLUEPRINT_BYTES,
  normalizedWeights,
  parseBlueprint,
  protocolAdapters,
  sameBlueprintConfig,
  type Blueprint,
  type BlueprintAction,
  type FoundryCurve,
  type FoundryIdentity,
} from "@/lib/foundry";
import nightAsset from "@/assets/studio-loco-night-station.png.asset.json";

export const Route = createFileRoute("/app/foundry")({
  validateSearch: z.object({ pool: z.string().max(44).optional() }),
  head: () => ({
    meta: [
      { title: "Strategy Foundry · The Observatory — Studio Loco" },
      {
        name: "description",
        content:
          "Versioned liquidity blueprints, custom Meteora DLMM bin weights, native order ladders and fresh wallet reviews linked to Flight Recorder.",
      },
    ],
  }),
  component: FoundryRoute,
});
function FoundryRoute() {
  const { pool } = Route.useSearch();
  return <StrategyFoundry initialPool={pool ?? ""} />;
}
interface Review {
  built: FoundryBuild;
  identity: FoundryIdentity;
  epoch: number;
  preparedAt: number;
  recordId: string;
}
const message = (e: unknown) => redactUrls(e instanceof Error ? e.message : String(e));
const sol = (n: number | null) =>
  n === null ? "Unavailable" : `${(n / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL`;
const tokenLabel = (m: string, side: string) =>
  m === "So11111111111111111111111111111111111111112"
    ? "SOL / WSOL"
    : m === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : `Token ${side}`;
export function AllocationChart({ bins }: { bins: Blueprint["liquidity"]["bins"] }) {
  const peak = Math.max(1, ...bins.flatMap((b) => [b.xBps, b.yBps]));
  const cell = 700 / bins.length,
    zero = bins.findIndex((b) => b.offset === 0);
  return (
    <svg
      role="img"
      aria-label="Nominal liquidity weights: token X above active, token Y below active"
      viewBox="0 0 760 220"
      className="mt-4 w-full"
    >
      {[50, 95, 140, 185].map((y) => (
        <line key={y} x1="30" x2="730" y1={y} y2={y} stroke="currentColor" opacity=".08" />
      ))}
      {bins.map((b, i) => (
        <g key={b.offset}>
          <rect
            x={30 + i * cell + 1}
            y={185 - (b.yBps / peak) * 135}
            width={Math.max(1, cell / 2 - 2)}
            height={(b.yBps / peak) * 135}
            fill="#3760f0"
          >
            <title>
              Bin {b.offset}: Y {b.yBps / 100}%
            </title>
          </rect>
          <rect
            x={30 + i * cell + cell / 2}
            y={185 - (b.xBps / peak) * 135}
            width={Math.max(1, cell / 2 - 2)}
            height={(b.xBps / peak) * 135}
            fill="#e6ac50"
          >
            <title>
              Bin {b.offset}: X {b.xBps / 100}%
            </title>
          </rect>
        </g>
      ))}
      {zero >= 0 && (
        <>
          <line
            x1={30 + (zero + 0.5) * cell}
            x2={30 + (zero + 0.5) * cell}
            y1="20"
            y2="190"
            stroke="#efe8d3"
            strokeDasharray="3 5"
            opacity=".65"
          />
          <text
            x={30 + (zero + 0.5) * cell}
            y="15"
            textAnchor="middle"
            fill="#efe8d3"
            fontSize="10"
            fontFamily="monospace"
          >
            ACTIVE · 0
          </text>
        </>
      )}
      <text x="30" y="211" fill="#aaa9b4" fontSize="11" fontFamily="monospace">
        {bins[0]!.offset} BINS
      </text>
      <text x="730" y="211" textAnchor="end" fill="#aaa9b4" fontSize="11" fontFamily="monospace">
        +{bins.at(-1)!.offset} BINS
      </text>
    </svg>
  );
}

export function StrategyFoundry({ initialPool = "" }: { initialPool?: string }) {
  const { connection } = useConnection(),
    wallet = useWallet(),
    { settings, hydrated } = useSettings();
  const runner = useTxRunner();
  const [address, setAddress] = useState(initialPool),
    [snapshot, setSnapshot] = useState<FoundryPoolSnapshot | null>(null);
  const [draft, setDraft] = useState<Blueprint | null>(null),
    [selected, setSelected] = useState<SavedBlueprint | null>(null);
  const [library, setLibrary] = useState<SavedBlueprint[]>([]),
    [libraryError, setLibraryError] = useState("");
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    savingLock = useRef(false);
  const [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [position, setPosition] = useState(""),
    [curve, setCurve] = useState<FoundryCurve>("curve"),
    [radius, setRadius] = useState(10);
  const [advanced, setAdvanced] = useState(false),
    [review, setReview] = useState<Review | null>(null),
    [clock, setClock] = useState(Date.now());
  const [records, setRecords] = useState<FlightRecord[]>([]),
    [action, setAction] = useState<BlueprintAction>("liquidity");
  const ctl = useRef(new JobControl()),
    epoch = useRef(0),
    mounted = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  const liveMode = hydrated && settings.cluster === "mainnet-beta" && !settings.practice;
  const owner = wallet.publicKey?.toBase58() ?? "";
  const identity: FoundryIdentity = {
    wallet: owner,
    cluster: settings.cluster,
    rpc: connection.rpcEndpoint,
    practice: settings.practice,
    digest: selected?.digest ?? "",
    action,
    position,
  };
  // Action selection happens synchronously inside prepare; it must not cancel its own job.
  const key = JSON.stringify([
    { ...identity, action: "review-action" },
    address,
    draft,
    selected?.key,
    libraryError,
  ]);
  const live = useRef({ identity, key });
  if (live.current.key !== key) epoch.current++;
  live.current = { identity, key };
  const suggestions = useQuery({
    queryKey: ["foundry-pool-suggestions"],
    queryFn: ({ signal }) =>
      fetchPools(
        {
          page: 1,
          pageSize: 3,
          query: "SOL-USDC",
          sort: "tvl",
          dir: "desc",
          hideBlacklisted: true,
        },
        signal,
      ),
    enabled: liveMode,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    mounted.current = true;
    ctl.current.mounted = true;
    const off = ctl.current.subscribe(() => {
      if (mounted.current) setBusy(ctl.current.busy);
    });
    const load = () => {
      void listBlueprints().then(
        (rows) => {
          if (mounted.current) {
            setLibrary(rows);
            setLibraryError("");
          }
        },
        (e) => {
          if (mounted.current) setLibraryError(message(e));
        },
      );
    };
    const offStore = subscribeFoundry(() => {
      epoch.current++;
      ctl.current.invalidate();
      setReview(null);
      load();
    });
    load();
    const loadRecords = () => {
      void listRecords().then(
        (rows) => {
          if (mounted.current) setRecords(rows);
        },
        () => {},
      );
    };
    const offRecords = subscribeRecorder(loadRecords);
    loadRecords();
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => {
      mounted.current = false;
      ctl.current.unmount();
      off();
      offStore();
      offRecords();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    ctl.current.invalidate();
    setReview(null);
  }, [key]);
  function invalidate() {
    epoch.current++;
    ctl.current.invalidate();
    setReview(null);
    setError("");
    setStatus("");
  }
  function edit(change: (b: Blueprint) => Blueprint) {
    invalidate();
    setDraft((b) => (b ? change(b) : b));
  }
  function choosePool(value: string) {
    invalidate();
    setAddress(value.trim());
    setSnapshot(null);
  }
  function chooseSaved(row: SavedBlueprint) {
    invalidate();
    setSelected(row);
    setDraft(structuredClone(row.blueprint));
    setAddress(row.blueprint.pool);
    setSnapshot(null);
    setPosition("");
    setRadius(Math.floor(row.blueprint.liquidity.bins.length / 2));
  }
  async function inspectPool() {
    if (!liveMode || runner.running) return;
    const job = ctl.current.begin();
    if (!job) return;
    setError("");
    setStatus("");
    setReview(null);
    try {
      const result = await readFoundryPool(connection, address, job);
      job.check();
      setSnapshot(result.snapshot);
      if (!draft || draft.pool !== address) {
        setDraft(draftBlueprint(result.snapshot));
        setSelected(null);
        setPosition("");
        setRadius(10);
        setCurve("curve");
      }
      setStatus("Pool, mint pair, clock and current fee configuration verified.");
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) setError(message(e));
    } finally {
      ctl.current.end(job);
    }
  }
  const parsed = draft ? BlueprintSchema.safeParse(draft) : null;
  const validation =
    parsed && !parsed.success
      ? parsed.error.issues
          .map((i) => i.message)
          .slice(0, 3)
          .join(" · ")
      : "";
  let geometry: ReturnType<typeof compileBlueprint> | null = null,
    geometryError = "";
  if (draft && snapshot && parsed?.success) {
    try {
      geometry = compileBlueprint(draft, {
        activeBinId: snapshot.activeBinId,
        decimalsX: snapshot.decimalsX,
        decimalsY: snapshot.decimalsY,
      });
    } catch (e) {
      geometryError = message(e);
    }
  }
  const dirty = !!draft && (!selected || !sameBlueprintConfig(draft, selected.blueprint));
  const latest = selected
    ? library
        .filter((row) => row.blueprint.id === selected.blueprint.id)
        .sort((a, b) => b.blueprint.revision - a.blueprint.revision)[0]
    : null;
  const canAppend = !!selected && latest?.key === selected.key;
  async function save(asCopy = false) {
    if (!draft || savingLock.current || validation || geometryError) return;
    const startKey = live.current.key;
    savingLock.current = true;
    setSaving(true);
    setError("");
    invalidate();
    try {
      const row = await saveBlueprint(draft, asCopy || !canAppend ? undefined : selected!);
      if (!mounted.current) return;
      if (live.current.key === startKey) {
        setSelected(row);
        setDraft(structuredClone(row.blueprint));
      }
      await recordFact({
        kind: "proposal",
        title: `Foundry blueprint saved · ${row.blueprint.name} r${row.blueprint.revision}`,
        route: "/app/foundry",
        cluster: "mainnet-beta",
        context: {
          recordType: "foundry-blueprint",
          blueprintId: row.blueprint.id,
          blueprintRevision: row.blueprint.revision,
          blueprintDigest: row.digest,
          pool: row.blueprint.pool,
          importedClaimsVerified: false,
        },
      });
      if (mounted.current)
        setStatus(
          `Revision ${row.blueprint.revision} saved on this device. Its previous revisions remain unchanged.`,
        );
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      savingLock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function importFile(file: File | undefined) {
    if (!file || savingLock.current) return;
    invalidate();
    try {
      if (file.size > MAX_BLUEPRINT_BYTES) throw new Error("Blueprint exceeds 25 KB.");
      const captured = epoch.current;
      const b = parseBlueprint(await file.text());
      if (!mounted.current || captured !== epoch.current) return;
      setDraft(b);
      setSelected(null);
      setSnapshot(null);
      setAddress(b.pool);
      setPosition("");
      setRadius(Math.floor(b.liquidity.bins.length / 2));
      setStatus(
        "Configuration imported. Save a local copy and verify its pool before preparing any action.",
      );
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  function exportSelected() {
    if (!selected) return;
    const blob = new Blob([canonicalBlueprint(selected.blueprint)], { type: "application/json" });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `loco-blueprint-${selected.blueprint.id}-r${selected.blueprint.revision}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Saved revision exported. Wallet history and transaction data are excluded.");
  }
  function pendingReason() {
    return browserPendingStore
      .list()
      .some(
        (p) =>
          p.wallet === live.current.identity.wallet && p.cluster === live.current.identity.cluster,
      )
      ? "Resolve the wallet's pending signature in Wallet Checks before preparing another action."
      : null;
  }
  async function prepare(nextAction: BlueprintAction) {
    if (
      !selected ||
      dirty ||
      libraryError ||
      address !== selected.blueprint.pool ||
      !liveMode ||
      !wallet.publicKey ||
      !runner.canSign ||
      runner.running ||
      savingLock.current
    )
      return;
    const pending = pendingReason();
    if (pending) {
      setError(pending);
      return;
    }
    // Invalidate synchronously: rapid action changes cannot resurrect an old review.
    invalidate();
    setAction(nextAction);
    live.current.identity = { ...live.current.identity, action: nextAction };
    const captured = epoch.current,
      startIdentity = { ...live.current.identity };
    const job = ctl.current.begin();
    if (!job) return;
    runner.reset();
    setStatus(
      `Building and simulating ${nextAction === "liquidity" ? "a weighted deposit" : `a ${nextAction} ladder`}…`,
    );
    try {
      const built = await buildFoundryAction({
        connection,
        owner: wallet.publicKey,
        blueprint: selected.blueprint,
        action: nextAction,
        position: nextAction === "liquidity" ? position.trim() || undefined : undefined,
        job,
      });
      job.check();
      // Render changing action bumps the epoch once. Freeze against the current identity,
      // but only when the immutable blueprint and all non-action inputs still match.
      const nowIdentity = live.current.identity;
      if (
        JSON.stringify({ ...nowIdentity, action: nextAction }) !== JSON.stringify(startIdentity) ||
        !mounted.current
      )
        throw new JobCancelled();
      const recordId = await job.step(
        recordFact({
          kind: "review",
          title: `Foundry ${nextAction} review · ${selected.blueprint.name}`,
          route: "/app/foundry",
          cluster: "mainnet-beta",
          wallet: owner,
          context: {
            recordType: "foundry-review",
            blueprintId: built.blueprint.id,
            blueprintRevision: built.blueprint.revision,
            blueprintDigest: built.digest,
            foundryAction: nextAction,
            pool: built.snapshot.address,
            targetAccount: built.account,
            activeBin: built.snapshot.activeBinId,
            lowerBin: built.compiled.lowerBinId,
            upperBin: built.compiled.upperBinId,
            chainSlot: built.snapshot.slot,
            networkFeeLamports: built.costs.feeLamports,
            upfrontSolLamports: built.costs.requiredLamports,
            simulationPassed: !built.costs.simErrors[0],
            simulatedAccountVerified: built.simulatedAccountVerified,
            approvalBlocked: !!built.refusal,
            totalFeeBps: built.snapshot.totalFeeBps,
          },
        }),
        12_000,
        "Recorder review",
      );
      job.check();
      setSnapshot(built.snapshot);
      setReview({
        built,
        identity: { ...nowIdentity, action: nextAction },
        epoch: epoch.current,
        preparedAt: Date.now(),
        recordId,
      });
      setClock(Date.now());
      setStatus(
        built.refusal
          ? "Simulation completed with a refusal. Adjust the blueprint and save a new revision."
          : "Fresh native simulation is ready for wallet review.",
      );
    } catch (e) {
      if (job.alive() && !(e instanceof JobCancelled)) {
        setError(message(e));
        setStatus("");
      }
    } finally {
      void captured;
      ctl.current.end(job);
    }
  }
  const reviewReason = review
    ? (review.built.refusal ?? foundryReviewReason(review, identity, epoch.current, clock))
    : null;
  async function approve() {
    const frozen = review;
    if (!frozen || !wallet.publicKey || !runner.canSign || runner.running) return;
    const guard = () =>
      frozen.built.refusal ??
      foundryReviewReason(frozen, live.current.identity, epoch.current) ??
      pendingReason();
    const blocked = guard();
    if (blocked) {
      setError(blocked);
      return;
    }
    try {
      const result = await runner.run(
        [
          {
            label:
              frozen.built.action === "liquidity"
                ? "Foundry · create/fund weighted liquidity"
                : `Foundry · place ${frozen.built.action} ladder`,
            tx: frozen.built.tx,
            signers: frozen.built.signers,
          },
        ],
        {
          semanticGuard: guard,
          asyncSemanticGuard: async () => {
            const before = guard();
            if (before) return before;
            const job = ctl.current.begin();
            if (!job)
              return "A previous pool check is still running. Prepare a new review when it drains.";
            try {
              const reason = await revalidateFoundryAction(
                connection,
                frozen.built,
                wallet.publicKey!,
                job,
              );
              job.check();
              return reason ?? guard();
            } catch (e) {
              return message(e);
            } finally {
              ctl.current.end(job);
            }
          },
          maxFeeLamports: frozen.built.blueprint.rules.maxNetworkFeeLamports,
          evidence: {
            title: `Foundry · ${frozen.built.blueprint.name} r${frozen.built.blueprint.revision}`,
            links: { reviewId: frozen.recordId },
            context: {
              recordType: "foundry-action",
              blueprintId: frozen.built.blueprint.id,
              blueprintRevision: frozen.built.blueprint.revision,
              blueprintDigest: frozen.built.digest,
              foundryAction: frozen.built.action,
              pool: frozen.built.snapshot.address,
              targetAccount: frozen.built.account,
              lowerBin: frozen.built.compiled.lowerBinId,
              upperBin: frozen.built.compiled.upperBinId,
            },
          },
        },
      );
      if (mounted.current) {
        setReview(null);
        setStatus(
          result.every((s) => s.phase === "confirmed")
            ? "Action confirmed. Its receipt and wallet balance evidence are linked below."
            : "Action ended. Check the wallet phases and Flight Recorder before preparing again.",
        );
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    }
  }
  const linked = selected
    ? records
        .filter(
          (r) =>
            r.context["blueprintId"] === selected.blueprint.id &&
            r.context["blueprintRevision"] === selected.blueprint.revision &&
            r.context["blueprintDigest"] === selected.digest,
        )
        .slice(0, 8)
    : [];
  const xName = draft ? tokenLabel(draft.mintX, "X") : "Token X",
    yName = draft ? tokenLabel(draft.mintY, "Y") : "Token Y";
  const prepareBlock = !liveMode
    ? "Switch to mainnet and turn off practice mode."
    : libraryError
      ? "Resolve the blueprint library error before preparing an action."
      : !wallet.publicKey
        ? "Connect a wallet to prepare a native simulation."
        : !runner.canSign
          ? "This wallet cannot sign transactions."
          : dirty
            ? "Save this blueprint revision first."
            : !selected
              ? "Save a blueprint first."
              : address !== selected.blueprint.pool
                ? "Verify the selected pool before preparing this blueprint."
                : null;
  const adapters = protocolAdapters();
  return (
    <div className="space-y-6">
      <section className="relative isolate overflow-hidden border border-line bg-[#101b3d]">
        <img
          src={nightAsset.url}
          alt="Studio Loco's midnight train under the Observatory sky"
          className="absolute inset-0 -z-20 h-full w-full object-cover object-center opacity-65"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-midnight via-midnight/85 to-midnight/20" />
        <div className="max-w-3xl px-6 py-10 md:px-9 md:py-14">
          <p className="station-code flex items-center gap-3 text-amber">
            <Waypoints size={16} /> ST-12 · The Observatory / Strategy Foundry
          </p>
          <h1 className="display mt-5 text-5xl leading-none text-cream md:text-7xl">
            Build a route.
            <br />
            <span className="text-amber">Keep the blueprint.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-cream/80">
            Shape your liquidity. Layer your orders. Save the exact strategy, then take every move
            through a fresh native simulation and your wallet.
          </p>
          <div className="mt-7 flex flex-wrap gap-3 station-code text-xs">
            <span className="border border-cream/25 bg-midnight/65 px-3 py-2">
              VERSIONED BLUEPRINTS
            </span>
            <span className="border border-cream/25 bg-midnight/65 px-3 py-2">NATIVE DLMM</span>
            <span className="border border-cream/25 bg-midnight/65 px-3 py-2">
              RECORDED OUTCOMES
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cream/15 bg-midnight/85 px-6 py-4 text-sm">
          <Link to="/app/agents" className="text-cream/75 hover:text-amber">
            ← The Observatory
          </Link>
          <Link to="/developers" className="flex items-center gap-2 text-amber">
            Blueprint SDK + read-only MCP <ArrowRight size={14} />
          </Link>
        </div>
      </section>
      {!liveMode && (
        <Notice tone="warn" title="Action paused">
          Foundry chain reads and wallet actions are paused. Use mainnet with practice mode off.
          Your saved configuration remains available.
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="Could not complete">
          {error}
        </Notice>
      )}
      {status && <Notice title="Foundry status">{status}</Notice>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6 min-w-0">
          <Panel>
            <div className="mb-5 flex items-center justify-between gap-3">
              <p className="station-code flex items-center gap-2 text-amber">
                <span className="border border-amber/40 px-2 py-1">01</span> Choose the pool
              </p>
              <span className="station-code text-xs text-cream/50">MAINNET · VERIFIED ON READ</span>
            </div>
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
              <Field
                className="flex-1"
                label="DLMM pool address"
                placeholder="Paste the exact pool address"
                value={address}
                onChange={(e) => choosePool(e.target.value)}
              />
              <Btn
                disabled={!liveMode || !address || busy || runner.running}
                onClick={() => void inspectPool()}
              >
                {busy ? "Checking…" : "Verify pool"}
              </Btn>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-cream/60">
              <span>From the live Meteora index:</span>
              {suggestions.data?.data.map((p) => (
                <button
                  key={p.address}
                  className="min-h-9 border border-line px-3 text-cream/80 hover:border-amber"
                  onClick={() => choosePool(p.address)}
                >
                  {p.name} · {p.pool_config?.bin_step ?? "?"} bps
                </button>
              ))}
              {suggestions.isError && <span>Pool suggestions unavailable. Paste an address.</span>}
            </div>
            {snapshot && (
              <div className="mt-5 border-t border-line pt-5">
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <Stat label="Active bin" value={snapshot.activeBinId} />
                  <Stat label="Bin step" value={`${snapshot.binStep} bps`} />
                  <Stat
                    label="Native orders"
                    value={snapshot.limitOrders ? "Eligible" : "Unavailable"}
                  />
                  <Stat
                    label="Pool state"
                    value={snapshot.enabled && snapshot.activated ? "Active" : "Paused"}
                  />
                </div>
                <p className="mt-4 break-all font-mono text-[11px] text-cream/55">
                  X {snapshot.mintX}
                  <br />Y {snapshot.mintY}
                  <br />
                  Confirmed pool account slot {snapshot.slot.toLocaleString()}
                </p>
                {!snapshot.supportedMints && (
                  <Notice tone="warn" title="Action paused">
                    {snapshot.mintNotes.join(" ")}
                  </Notice>
                )}
              </div>
            )}
          </Panel>
          {draft ? (
            <>
              <Panel>
                <p className="station-code mb-5 flex items-center gap-2 text-amber">
                  <span className="border border-amber/40 px-2 py-1">02</span> Shape the liquidity
                </p>
                <Field
                  label="Blueprint name"
                  value={draft.name}
                  maxLength={60}
                  onChange={(e) => edit((b) => ({ ...b, name: e.target.value }))}
                />
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <Field
                    label={`${xName} budget · X`}
                    value={draft.liquidity.budgetX}
                    inputMode="decimal"
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        liquidity: { ...b.liquidity, budgetX: e.target.value },
                      }))
                    }
                  />
                  <Field
                    label={`${yName} budget · Y`}
                    value={draft.liquidity.budgetY}
                    inputMode="decimal"
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        liquidity: { ...b.liquidity, budgetY: e.target.value },
                      }))
                    }
                  />
                </div>
                <div className="mt-6 flex flex-wrap items-end gap-5">
                  <div>
                    <p className="station-code mb-2 text-xs text-cream/60">Starting shape</p>
                    <Segmented<FoundryCurve>
                      label="Liquidity shape"
                      value={curve}
                      options={[
                        { value: "uniform", label: "Uniform" },
                        { value: "curve", label: "Curve" },
                        { value: "bid-ask", label: "Bid / ask" },
                      ]}
                      onChange={(c) => {
                        setCurve(c);
                        edit((b) => ({
                          ...b,
                          liquidity: { ...b.liquidity, bins: foundryBins(radius, c) },
                        }));
                      }}
                    />
                  </div>
                  <div className="min-w-48 flex-1">
                    <label
                      htmlFor="foundry-radius"
                      className="station-code mb-2 flex justify-between text-xs text-cream/60"
                    >
                      <span>Range radius</span>
                      <span>{radius * 2 + 1} bins</span>
                    </label>
                    <input
                      id="foundry-radius"
                      type="range"
                      min="1"
                      max="34"
                      value={radius}
                      className="w-full accent-[var(--amber)]"
                      onChange={(e) => {
                        const r = Number(e.target.value);
                        setRadius(r);
                        edit((b) => ({
                          ...b,
                          liquidity: { ...b.liquidity, bins: foundryBins(r, curve) },
                        }));
                      }}
                    />
                  </div>
                </div>
                <AllocationChart bins={draft.liquidity.bins} />
                <div className="flex flex-wrap justify-between gap-3 text-xs text-cream/65">
                  <span>
                    <i className="mr-2 inline-block size-2 bg-[#3760f0]" />Y below active{" "}
                    <i className="ml-5 mr-2 inline-block size-2 bg-amber" />X above active
                  </span>
                  <span>Nominal weights · integer allocation · native rounding applies</span>
                </div>
                {geometry && (
                  <p className="mt-4 station-code text-xs text-cream/60">
                    Current compiled range {geometry.lowerBinId} → {geometry.upperBinId} · relative
                    to the freshly observed active bin
                  </p>
                )}
                <details
                  className="mt-5 border-t border-line pt-4"
                  open={advanced}
                  onToggle={(e) => setAdvanced(e.currentTarget.open)}
                >
                  <summary className="cursor-pointer text-sm text-amber">
                    Edit every bin allocation
                  </summary>
                  <div className="mt-4 flex gap-2">
                    <Btn
                      size="sm"
                      variant="line"
                      onClick={() => {
                        try {
                          const weights = normalizedWeights(
                            draft.liquidity.bins.map((b) => b.xBps),
                          );
                          edit((b) => ({
                            ...b,
                            liquidity: {
                              ...b.liquidity,
                              bins: b.liquidity.bins.map((v, i) => ({ ...v, xBps: weights[i]! })),
                            },
                          }));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Normalize X
                    </Btn>
                    <Btn
                      size="sm"
                      variant="line"
                      onClick={() => {
                        try {
                          const weights = normalizedWeights(
                            draft.liquidity.bins.map((b) => b.yBps),
                          );
                          edit((b) => ({
                            ...b,
                            liquidity: {
                              ...b.liquidity,
                              bins: b.liquidity.bins.map((v, i) => ({ ...v, yBps: weights[i]! })),
                            },
                          }));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Normalize Y
                    </Btn>
                  </div>
                  <div className="mt-3 max-h-72 overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="station-code text-cream/60">
                        <tr>
                          <th className="py-2">Offset</th>
                          <th>X basis points</th>
                          <th>Y basis points</th>
                        </tr>
                      </thead>
                      <tbody>
                        {draft.liquidity.bins.map((bin, i) => (
                          <tr key={bin.offset} className="border-t border-line">
                            <td className="py-3 font-mono">
                              {bin.offset > 0 ? "+" : ""}
                              {bin.offset}
                            </td>
                            {(["xBps", "yBps"] as const).map((side) => (
                              <td key={side}>
                                <input
                                  aria-label={`Bin ${bin.offset} ${side === "xBps" ? "X" : "Y"} basis points`}
                                  type="number"
                                  min="0"
                                  max="10000"
                                  value={bin[side]}
                                  className="min-h-10 w-24 border border-line bg-midnight px-2 font-mono"
                                  onChange={(e) =>
                                    edit((b) => ({
                                      ...b,
                                      liquidity: {
                                        ...b.liquidity,
                                        bins: b.liquidity.bins.map((v, j) =>
                                          j === i ? { ...v, [side]: Number(e.target.value) } : v,
                                        ),
                                      },
                                    }))
                                  }
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-3 text-xs text-cream/60">
                    Each funded token totals 10,000 bps. X belongs at or above active; Y at or
                    below. No automatic normalization is hidden in a wallet action.
                  </p>
                </details>
                <Field
                  className="mt-5"
                  label="Existing PositionV2 address (optional)"
                  placeholder="Leave empty to create a new position"
                  value={position}
                  onChange={(e) => {
                    invalidate();
                    setPosition(e.target.value.trim());
                  }}
                  hint="An existing position must belong to your wallet and this pool, with exactly the compiled bounds."
                />
              </Panel>
              <Panel>
                <p className="station-code mb-5 flex items-center gap-2 text-amber">
                  <span className="border border-amber/40 px-2 py-1">03</span> Layer native orders
                </p>
                <p className="mb-5 text-sm text-cream/70">
                  Buy X with Y below active, or sell X for Y above active. Each ladder has its own
                  budget and a separate atomic wallet review. Native orders fill only when pool
                  trading reaches their bins.
                </p>
                <div className="grid gap-5 md:grid-cols-2">
                  {(["buy", "sell"] as const).map((side) => {
                    const ladder = draft.ladders.find((l) => l.side === side);
                    return (
                      <div key={side} className="border border-line bg-midnight/40 p-4">
                        <label className="flex min-h-10 items-center justify-between gap-3 station-code text-sm">
                          <span>
                            {side === "buy" ? "Buy ladder · Y → X" : "Sell ladder · X → Y"}
                          </span>
                          <input
                            type="checkbox"
                            checked={!!ladder}
                            className="size-5 accent-[var(--amber)]"
                            onChange={(e) =>
                              edit((b) => ({
                                ...b,
                                ladders: e.target.checked
                                  ? [
                                      ...b.ladders,
                                      {
                                        side,
                                        budget: "0",
                                        bins: [4, 8, 12].map((n, i) => ({
                                          offset: side === "buy" ? -n : n,
                                          weightBps: i === 0 ? 3334 : 3333,
                                        })),
                                      },
                                    ]
                                  : b.ladders.filter((l) => l.side !== side),
                              }))
                            }
                          />
                        </label>
                        {ladder && (
                          <div className="mt-4 space-y-4">
                            <Field
                              label={`${side} budget · ${side === "buy" ? yName : xName}`}
                              value={ladder.budget}
                              inputMode="decimal"
                              onChange={(e) =>
                                edit((b) => ({
                                  ...b,
                                  ladders: b.ladders.map((l) =>
                                    l.side === side ? { ...l, budget: e.target.value } : l,
                                  ),
                                }))
                              }
                            />
                            {ladder.bins.map((bin, i) => (
                              <div
                                key={i}
                                className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
                              >
                                <Field
                                  id={`${side}-offset-${i}`}
                                  label={`Level ${i + 1} offset`}
                                  type="number"
                                  value={bin.offset}
                                  min={side === "buy" ? -68 : 1}
                                  max={side === "buy" ? -1 : 68}
                                  onChange={(e) =>
                                    edit((b) => ({
                                      ...b,
                                      ladders: b.ladders.map((l) =>
                                        l.side === side
                                          ? {
                                              ...l,
                                              bins: l.bins.map((v, j) =>
                                                j === i
                                                  ? { ...v, offset: Number(e.target.value) }
                                                  : v,
                                              ),
                                            }
                                          : l,
                                      ),
                                    }))
                                  }
                                />
                                <Field
                                  id={`${side}-weight-${i}`}
                                  label="Weight bps"
                                  type="number"
                                  value={bin.weightBps}
                                  min="1"
                                  max="10000"
                                  onChange={(e) =>
                                    edit((b) => ({
                                      ...b,
                                      ladders: b.ladders.map((l) =>
                                        l.side === side
                                          ? {
                                              ...l,
                                              bins: l.bins.map((v, j) =>
                                                j === i
                                                  ? { ...v, weightBps: Number(e.target.value) }
                                                  : v,
                                              ),
                                            }
                                          : l,
                                      ),
                                    }))
                                  }
                                />
                                <button
                                  aria-label={`Remove ${side} level ${i + 1}`}
                                  disabled={ladder.bins.length === 1}
                                  className="min-h-11 px-2 text-cream/60 disabled:opacity-30"
                                  onClick={() =>
                                    edit((b) => ({
                                      ...b,
                                      ladders: b.ladders.map((l) =>
                                        l.side === side
                                          ? { ...l, bins: l.bins.filter((_, j) => j !== i) }
                                          : l,
                                      ),
                                    }))
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <div className="flex flex-wrap gap-2">
                              <Btn
                                size="sm"
                                variant="line"
                                disabled={ladder.bins.length >= 12}
                                onClick={() =>
                                  edit((b) => ({
                                    ...b,
                                    ladders: b.ladders.map((l) =>
                                      l.side === side
                                        ? {
                                            ...l,
                                            bins: [
                                              ...l.bins,
                                              {
                                                offset:
                                                  side === "buy"
                                                    ? -Math.min(68, 4 * (l.bins.length + 1))
                                                    : Math.min(68, 4 * (l.bins.length + 1)),
                                                weightBps: 1,
                                              },
                                            ],
                                          }
                                        : l,
                                    ),
                                  }))
                                }
                              >
                                <Plus size={13} />
                                Level
                              </Btn>
                              <Btn
                                size="sm"
                                variant="line"
                                onClick={() => {
                                  const weights = normalizedWeights(
                                    ladder.bins.map((b) => b.weightBps),
                                  );
                                  edit((b) => ({
                                    ...b,
                                    ladders: b.ladders.map((l) =>
                                      l.side === side
                                        ? {
                                            ...l,
                                            bins: l.bins.map((v, i) => ({
                                              ...v,
                                              weightBps: weights[i]!,
                                            })),
                                          }
                                        : l,
                                    ),
                                  }));
                                }}
                              >
                                Normalize
                              </Btn>
                            </div>
                            <p className="text-xs text-cream/55">
                              Order capital is separate from the liquidity budget. Unfilled levels
                              remain resting orders.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>
              <Panel>
                <p className="station-code mb-5 flex items-center gap-2 text-amber">
                  <span className="border border-amber/40 px-2 py-1">04</span> Set the review rules
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Price tolerance (bps)"
                    type="number"
                    min="1"
                    max="500"
                    value={draft.rules.slippageBps}
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        rules: { ...b.rules, slippageBps: Number(e.target.value) },
                      }))
                    }
                    hint="Bounds the native active-bin movement, together with the drift limit."
                  />
                  <Field
                    label="Active-bin drift limit"
                    type="number"
                    min="0"
                    max="20"
                    value={draft.rules.maxActiveBinDrift}
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        rules: { ...b.rules, maxActiveBinDrift: Number(e.target.value) },
                      }))
                    }
                    hint="0 requires the active bin to stay fixed through wallet approval."
                  />
                  <Field
                    label="Network fee ceiling (lamports)"
                    type="number"
                    min="1"
                    max="1000000000"
                    value={draft.rules.maxNetworkFeeLamports}
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        rules: { ...b.rules, maxNetworkFeeLamports: Number(e.target.value) },
                      }))
                    }
                  />
                  <Field
                    label="Current swap fee ceiling (bps)"
                    type="number"
                    min="1"
                    max="10000"
                    value={draft.rules.maxTotalFeeBps}
                    onChange={(e) =>
                      edit((b) => ({
                        ...b,
                        rules: { ...b.rules, maxTotalFeeBps: Number(e.target.value) },
                      }))
                    }
                    hint="A pool-selection guard; this is not a deposit charge or future fee guarantee."
                  />
                </div>
                <p className="mt-5 text-sm text-cream/60">
                  Rules guard a reviewed action; they do not run a background keeper. A blueprint
                  never delegates signing or authorizes later transactions.
                </p>
              </Panel>
            </>
          ) : (
            <Panel tone="cobalt">
              <Layers3 className="mb-5 text-amber" size={28} />
              <h2 className="display text-3xl">A strategy worth keeping.</h2>
              <p className="mt-3 max-w-lg leading-7 text-cream/70">
                Verify a pool to start composing its exact mint pair. Or import a blueprint and make
                a local copy. Your library keeps every saved revision so each review has a precise
                reference.
              </p>
              <div className="mt-7 grid gap-4 sm:grid-cols-3">
                {["Custom bin weights", "Buy / sell ladders", "Recorder evidence"].map(
                  (label, i) => (
                    <div key={label} className="border border-cream/20 p-4">
                      <p className="station-code text-amber">0{i + 1}</p>
                      <p className="mt-2 text-sm">{label}</p>
                    </div>
                  ),
                )}
              </div>
            </Panel>
          )}
        </div>
        <aside className="space-y-6 min-w-0">
          <Panel className="border-t-2 border-t-amber">
            <p className="station-code mb-5 flex items-center gap-2 text-amber">
              <Fingerprint size={15} /> Blueprint library
            </p>
            {libraryError && (
              <Notice tone="error" title="Could not complete">
                {libraryError}
              </Notice>
            )}
            <label
              htmlFor="foundry-revision"
              className="station-code mb-2 block text-xs text-cream/60"
            >
              Immutable saved revisions
            </label>
            <select
              id="foundry-revision"
              value={selected?.key ?? ""}
              className="min-h-11 w-full border border-line bg-midnight px-3 text-sm"
              onChange={(e) => {
                const row = library.find((r) => r.key === e.target.value);
                if (row) chooseSaved(row);
              }}
            >
              <option value="">
                {library.length ? "Select a revision" : "No saved blueprints yet"}
              </option>
              {library.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.blueprint.name} · r{row.blueprint.revision}
                </option>
              ))}
            </select>
            <div className="mt-3 flex gap-2">
              <Btn
                size="sm"
                variant="line"
                onClick={() => fileInput.current?.click()}
                disabled={saving}
              >
                <Upload size={14} />
                Import
              </Btn>
              <Btn size="sm" variant="line" onClick={exportSelected} disabled={!selected}>
                <Download size={14} />
                Export
              </Btn>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Import liquidity blueprint JSON"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
            {draft && (
              <div className="mt-5 space-y-3 border-t border-line pt-5">
                <div className="flex items-center justify-between text-sm">
                  <span>
                    {dirty ? "Unsaved changes" : `Revision ${selected?.blueprint.revision}`}
                  </span>
                  <span className={dirty ? "text-amber" : "text-success"}>
                    {dirty ? "DRAFT" : "SAVED"}
                  </span>
                </div>
                {validation || geometryError ? (
                  <p role="alert" className="text-xs leading-5 text-destructive">
                    {validation || geometryError}
                  </p>
                ) : null}
                <Btn
                  className="w-full"
                  disabled={saving || !!validation || !!geometryError || !!libraryError || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : canAppend ? "Save next revision" : "Save new blueprint"}
                </Btn>
                {selected && (
                  <Btn
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={saving || !!validation}
                    onClick={() => void save(true)}
                  >
                    Save as a new blueprint
                  </Btn>
                )}
                {selected && (
                  <p className="break-all font-mono text-[10px] leading-5 text-cream/50">
                    SHA-256 {selected.digest}
                  </p>
                )}
              </div>
            )}
            <p className="mt-4 text-xs leading-5 text-cream/55">
              Stored on this device. Exported JSON contains only public configuration. Imports
              always require a new pool check, native simulation and wallet approval.
            </p>
          </Panel>
          <Panel>
            <p className="station-code mb-5 flex items-center gap-2 text-amber">
              <Radio size={15} /> Fee weather
            </p>
            {snapshot ? (
              <>
                <div className="grid grid-cols-2 gap-5">
                  <Stat label="Base" value={`${snapshot.baseFeeBps.toFixed(3)} bps`} />
                  <Stat label="Variable" value={`${snapshot.variableFeeBps.toFixed(3)} bps`} />
                  <Stat label="Total now" value={`${snapshot.totalFeeBps.toFixed(3)} bps`} />
                  <Stat
                    label="Fee currency"
                    value={snapshot.feeCurrency === "input" ? "Swap input" : "Token Y"}
                  />
                </div>
                <p className="mt-5 text-xs leading-5 text-cream/55">
                  Protocol share: {(snapshot.protocolShareBps / 100).toFixed(2)}% of swap fees.
                  Protocol maximum: {snapshot.maxFeeBps.toFixed(2)} bps. Observed{" "}
                  {new Date(snapshot.observedAt).toLocaleTimeString()}. Each review refreshes the
                  pool. These are swap settings, not an earnings forecast.
                </p>
              </>
            ) : (
              <p className="text-sm leading-6 text-cream/60">
                Verify a pool to inspect its actual base fee, variable fee and fee collection
                currency.
              </p>
            )}
          </Panel>
          <Panel tone="cobalt">
            <p className="station-code mb-5 flex items-center gap-2 text-amber">
              <ShieldCheck size={15} /> Native action review
            </p>
            {prepareBlock && <p className="mb-4 text-sm leading-6 text-cream/70">{prepareBlock}</p>}
            {!wallet.publicKey && (
              <div className="mb-4">
                <WalletButton />
              </div>
            )}
            <div className="space-y-2">
              <Btn
                className="w-full"
                disabled={!!prepareBlock || busy || runner.running || saving || !!validation}
                onClick={() => void prepare("liquidity")}
              >
                Review weighted liquidity
              </Btn>
              {(["buy", "sell"] as const).map((side) => (
                <Btn
                  key={side}
                  className="w-full"
                  variant="line"
                  disabled={
                    !!prepareBlock ||
                    busy ||
                    runner.running ||
                    saving ||
                    !draft?.ladders.some((l) => l.side === side) ||
                    snapshot?.limitOrders === false
                  }
                  onClick={() => void prepare(side)}
                >
                  Review {side} ladder
                </Btn>
              ))}
            </div>
            {busy && (
              <div className="mt-4">
                <Spinner label="Checking native state and costs" />
              </div>
            )}
            {review && (
              <div className="mt-5 space-y-4 border-t border-cream/20 pt-5">
                <div className="flex items-center justify-between station-code text-xs">
                  <span>
                    {review.built.action.toUpperCase()} · r{review.built.blueprint.revision}
                  </span>
                  <span className="text-amber">
                    {Math.max(
                      0,
                      Math.ceil((FOUNDRY_REVIEW_TTL - (clock - review.preparedAt)) / 1000),
                    )}
                    s
                  </span>
                </div>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-cream/60">Network fee</dt>
                    <dd>{sol(review.built.costs.feeLamports)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-cream/60">Upfront SOL</dt>
                    <dd>{sol(review.built.costs.requiredLamports)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-cream/60">Simulated SOL out</dt>
                    <dd>{sol(review.built.costs.solOutLamports)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-cream/60">Transaction</dt>
                    <dd>{review.built.costs.sizes[0]} bytes</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-cream/60">Compute units</dt>
                    <dd>{review.built.costs.units[0]?.toLocaleString() ?? "Unavailable"}</dd>
                  </div>
                </dl>
                <p className="text-xs leading-5 text-cream/65">
                  {review.built.action === "liquidity"
                    ? `Budget: X ${review.built.blueprint.liquidity.budgetX} + Y ${review.built.blueprint.liquidity.budgetY}. Native 16-bit price-value weights and program rounding determine actual allocations.`
                    : `Order budget: ${review.built.blueprint.ladders.find((l) => l.side === review.built.action)?.budget} ${review.built.action === "buy" ? "Y" : "X"}. Levels: ${review.built.compiled.ladders
                        .find((l) => l.side === review.built.action)
                        ?.bins.map((b) => b.binId)
                        .join(", ")}. This is order placement, not a fill.`}
                </p>
                <p className="break-all text-xs text-cream/55">
                  {review.built.action === "liquidity" ? "Position" : "Order"}:{" "}
                  {review.built.account}
                </p>
                {reviewReason && (
                  <Notice tone="warn" title="Action paused">
                    {reviewReason}
                  </Notice>
                )}
                <Btn
                  className="w-full"
                  disabled={!!reviewReason || !runner.canSign || runner.running || busy}
                  onClick={() => void approve()}
                >
                  <Check size={15} />
                  Approve in wallet
                </Btn>
                <Link
                  to="/app/recorder"
                  search={{ id: review.recordId }}
                  className="block text-xs text-amber underline"
                >
                  Inspect the recorded review
                </Link>
              </div>
            )}
            {runner.steps && (
              <div className="mt-5">
                <TxSteps steps={runner.steps} />
              </div>
            )}
            <p className="mt-5 text-xs leading-5 text-cream/55">
              One atomic action per approval. Unknown costs, failed simulation and stale reviews
              block signing. Temporary SOL rent is included upfront; existing WSOL accounts remain
              open.
            </p>
          </Panel>
          <Panel>
            <p className="station-code mb-4 text-cream/65">Protocol adapters</p>
            <div className="flex justify-between text-sm">
              <span>Meteora DLMM</span>
              <span className="text-success">Native adapter</span>
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span>DLMM Pro</span>
              <span className="text-cream/50">Unverified · gated</span>
            </div>
            <p className="mt-4 text-xs leading-5 text-cream/55">{adapters.adapters[1]!.reason}</p>
          </Panel>
        </aside>
      </div>
      <Panel>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="station-code flex items-center gap-2 text-amber">
              <Fingerprint size={15} /> Flight Recorder · this revision
            </p>
            <h2 className="display mt-3 text-3xl">A route with a record.</h2>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link to="/app/journey" search={{ blueprint: selected?.blueprint.id }} className="text-sm text-amber underline">Follow The Journey</Link>
            <Link to="/app/recorder" className="text-sm text-amber underline">Open Flight Recorder</Link>
          </div>
        </div>
        {linked.length ? (
          <div className="divide-y divide-line">
            {linked.map((r) => (
              <Link
                key={r.id}
                to="/app/recorder"
                search={{ id: r.id }}
                className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm hover:text-amber"
              >
                <span>
                  {r.title}
                  <span className="mt-1 block text-xs text-cream/50">
                    {new Date(r.createdAt).toLocaleString()} · {r.kind}
                    {r.postState?.[0]?.feeLamports != null
                      ? ` · verified fee ${sol(r.postState[0]!.feeLamports)}`
                      : ""}
                  </span>
                </span>
                <span
                  className={
                    r.status === "confirmed"
                      ? "station-code text-success"
                      : "station-code text-cream/65"
                  }
                >
                  {r.status} ↗
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-7 text-cream/60">
            Save a blueprint and prepare its first review to start this timeline. Confirmed actions
            carry public signatures; wallet balance evidence is verified separately when the RPC
            makes it available. This timeline does not calculate profit or order fills.
          </p>
        )}
        {draft && (
          <div className="mt-5 flex flex-wrap gap-5 border-t border-line pt-5 text-sm">
            <Link
              to="/app/pool/$address"
              params={{ address: draft.pool }}
              className="text-amber underline"
            >
              Manage this pool's positions and orders
            </Link>
            <Link to="/app/agents" className="text-amber underline">
              Set Observatory rules for a confirmed position
            </Link>
          </div>
        )}
      </Panel>
    </div>
  );
}

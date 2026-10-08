import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { Btn, Field, Notice, PageHead, Panel, Segmented, Spinner, Stat } from "@/components/kit";
import { useCloudSession, AccountPanel } from "@/components/signal/account";
import { exportBundle, parseImport, type FlightRecord } from "@/lib/recorder";
import {
  adoptPending,
  deleteRecord,
  listRecords,
  putRecord,
  recorderVersion,
  subscribeRecorder,
  syncToCloud,
  usingMemoryFallback,
} from "@/lib/recorder-store";
import { browserPendingStore } from "@/lib/tx";
import { explorerTx, shortAddr } from "@/lib/format";
import { formatUnits } from "@/lib/amount";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/recorder")({
  validateSearch: z.object({ id: z.string().max(80).optional() }),
  head: () => ({
    meta: [
      { title: "The Flight Recorder — action evidence · Studio Loco" },
      {
        name: "description",
        content:
          "Private, structured evidence for every proposal, review and wallet action: simulation, wallet phases, public signatures and separately verified balance changes.",
      },
      { property: "og:title", content: "The Flight Recorder — Studio Loco" },
      {
        property: "og:description",
        content:
          "Per-action evidence stored on your device, with optional private cloud sync and strict JSON export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Recorder,
});

type Filter = "all" | "wallet-action" | "proposal" | "review" | "alert-handoff";
const STATUS_STYLE: Record<FlightRecord["status"], string> = {
  confirmed: "border-success text-success",
  failed: "border-destructive text-destructive",
  rejected: "border-cream/60 text-cream/80",
  expired: "border-cream/60 text-cream/80",
  unknown: "border-amber text-amber",
  partial: "border-ochre text-ochre",
  open: "border-amber text-amber",
  info: "border-line text-cream/70",
};

function Recorder() {
  const search = Route.useSearch();
  const v = useSyncExternalStore(subscribeRecorder, recorderVersion, () => 0);
  const [records, setRecords] = useState<FlightRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(search.id ?? null);
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { session } = useCloudSession();
  useEffect(() => {
    void adoptPending(browserPendingStore.list()).catch(() => {});
  }, []);
  useEffect(() => {
    listRecords().then(setRecords, (e) => setErr(String(e)));
  }, [v]);
  useEffect(() => {
    setSel(search.id ?? null);
  }, [search.id]);
  const rows = useMemo(
    () =>
      (records ?? []).filter(
        (r) =>
          (filter === "all" || r.kind === filter) &&
          (!q ||
            JSON.stringify([r.title, r.links, r.steps.map((s) => s.signature)])
              .toLowerCase()
              .includes(q.toLowerCase())),
      ),
    [records, filter, q],
  );
  const cur = rows.find((r) => r.id === sel) ?? (records ?? []).find((r) => r.id === sel) ?? null;
  function download() {
    const blob = new Blob([JSON.stringify(exportBundle(rows), null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `studio-loco-flight-recorder-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importFile(f: File) {
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error("Export exceeds 5 MB");
      const { records: rs, rejected } = parseImport(JSON.parse(await f.text()));
      for (const r of rs) await putRecord(r);
      setMsg(
        `Imported ${rs.length} record(s) marked "import"${rejected ? `; ${rejected} rejected by validation` : ""}.`,
      );
    } catch {
      setMsg("Import stopped. Choose a valid Flight Recorder JSON export smaller than 5 MB.");
    }
  }
  async function sync() {
    if (syncing) return;
    setSyncing(true);
    setMsg("Syncing…");
    try {
      const r = await syncToCloud(records ?? []);
      setMsg(
        r.error
          ? `Sync stopped: ${r.error}`
          : `Synced: ${r.pushed} device record(s) uploaded, ${r.pulled} newer record(s) pulled.`,
      );
    } catch {
      setMsg("Sync stopped. Your device records are still available; retry when connected.");
    } finally {
      setSyncing(false);
    }
  }
  return (
    <div>
      <PageHead
        code="ST-09 · The Flight Recorder"
        title="Every lamp, logged."
        cap={["live"]}
        intro="Structured evidence for proposals, reviews and every wallet action from any page: what was reviewed, simulation result, each wallet phase, the public signature, and a separately verified balance change. Facts only — no PnL is inferred."
      />
      <Panel className="mb-6">
        <p className="text-sm text-cream/80">
          <strong>Storage.</strong> Records live in this browser (IndexedDB)
          {usingMemoryFallback()
            ? " — some writes are held in memory for this session only; export before closing this tab"
            : ""}
          . They contain public metadata only: no RPC URLs, credentials or signed transaction bytes.
          Signing in lets you copy them to your private cloud workspace, readable only by your
          account. Wallet evidence and unresolved actions are retained; the latest 2,000 other facts
          are kept. Imports receive separate identities and remain labelled as imported evidence.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn size="sm" variant="line" onClick={download} disabled={!rows.length}>
            Export JSON ({rows.length})
          </Btn>
          <label className="station-code inline-flex min-h-10 cursor-pointer items-center border border-line px-3 hover:border-amber">
            Import JSON
            <input
              type="file"
              accept="application/json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {session ? (
            <Btn size="sm" variant="line" onClick={sync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync with private cloud"}
            </Btn>
          ) : null}
        </div>
        {msg && (
          <p className="mt-2 text-sm text-cream/85" role="status">
            {msg}
          </p>
        )}
      </Panel>
      {!session && (
        <details className="mb-6">
          <summary className="station-code cursor-pointer text-cream/75">
            Optional: sign in for private cloud sync
          </summary>
          <div className="mt-3">
            <AccountPanel purpose="sync your Flight Recorder" />
          </div>
        </details>
      )}
      {err ? (
        <Notice tone="error" title="Couldn't open device storage">
          {err}
        </Notice>
      ) : !records ? (
        <Spinner label="Opening the recorder" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <Segmented<Filter>
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "wallet-action", label: "Wallet" },
                  { value: "proposal", label: "Proposals" },
                  { value: "review", label: "Reviews" },
                  { value: "alert-handoff", label: "Alerts" },
                ]}
              />
              <div className="min-w-[180px] flex-1">
                <Field
                  label="Search title, link or signature"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>
            {!rows.length ? (
              <Panel>
                <p className="text-cream/80">
                  Nothing recorded yet. Proposals and reviews from the{" "}
                  <Link to="/app/agents" className="underline">
                    Observatory
                  </Link>{" "}
                  and{" "}
                  <Link to="/app/dispatch" className="underline">
                    Dispatch
                  </Link>
                  , Signal Box alert hand-offs and every wallet action appear here automatically.
                </p>
              </Panel>
            ) : (
              <ul
                className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto pr-1"
                aria-label="Records"
              >
                {rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSel(r.id)}
                      aria-current={sel === r.id}
                      className={cn(
                        "ticket block w-full p-3 text-left hover:bg-cobalt focus-visible:outline-2 focus-visible:outline-amber",
                        sel === r.id && "bg-cobalt",
                      )}
                    >
                      <div className="flex justify-between gap-2">
                        <span className="station-code text-cream/60">
                          {r.kind} · {r.provenance}
                        </span>
                        <span className={cn("station-code border px-1.5", STATUS_STYLE[r.status])}>
                          {r.status}
                        </span>
                      </div>
                      <p className="mt-1 font-medium">{r.title}</p>
                      <p className="station-code text-cream/60">
                        {new Date(r.updatedAt).toLocaleString()} · {r.route || "—"}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            {cur ? (
              <Detail
                r={cur}
                related={(records ?? []).filter((r) => r.id !== cur.id && (r.links.recordId === cur.id || (cur.context['recordType'] === 'rebalance-comparison' && r.links.proposalId === cur.id)))}
                onDelete={async () => {
                  try {
                    await deleteRecord(cur.id);
                    setSel(null);
                  } catch {
                    setMsg("Couldn't delete this record from device storage. Try again.");
                  }
                }}
              />
            ) : (
              <Panel>
                <p className="text-cream/70">Select a record to see its timeline.</p>
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ r, related, onDelete }: { r: FlightRecord; related: FlightRecord[]; onDelete: () => void }) {
  return (
    <Panel tone="cobalt">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="display text-2xl">{r.title}</h2>
        <span className={cn("station-code h-fit border px-2 py-1", STATUS_STYLE[r.status])}>
          {r.status}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Kind" value={r.kind} />
        <Stat label="Network" value={r.cluster || "—"} />
        <Stat label="RPC" value={r.rpc} />
        <Stat label="Wallet" value={r.wallet ? shortAddr(r.wallet) : "—"} />
      </div>
      {Object.keys(r.links).length > 0 && (
        <div className="mt-3">
          <p className="station-code text-cream/60">Links</p>
          <ul className="text-sm">
            {Object.entries(r.links).map(([k, v]) => (
              <li key={k}>
                <span className="station-code text-cream/60">{k}</span>{" "}
                {k === "recordId" ? (
                  <Link to="/app/recorder" search={{ id: v }} className="underline">
                    {v}
                  </Link>
                ) : (
                  <span className="break-all">{v}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {related.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="station-code text-amber">Connected evidence</p>
          <ul className="mt-2 space-y-1 text-sm">
            {related.map((child) => <li key={child.id}><Link to="/app/recorder" search={{ id: child.id }} className="underline">{child.title}</Link> · {child.status}</li>)}
          </ul>
        </div>
      )}
      {Object.keys(r.context).length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <p className="station-code text-cream/60">Reviewed context</p>
          <table className="text-sm">
            <tbody>
              {Object.entries(r.context).map(([k, v]) => (
                <tr key={k}>
                  <td className="pr-3 align-top station-code text-cream/60">{k}</td>
                  <td className="break-all">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.steps.length > 0 && (
        <div className="mt-3">
          <p className="station-code text-cream/60">Wallet steps</p>
          <ol className="text-sm">
            {r.steps.map((s, i) => (
              <li key={i} className="border-l-2 border-amber pl-3 py-1">
                <span className="station-code">{s.phase}</span> {s.label}
                {s.signature && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={explorerTx(s.signature, r.cluster as never)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {shortAddr(s.signature)}
                    </a>
                  </>
                )}
                {s.error && <p className="text-destructive">{s.error}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {r.provenance === "import" && (
        <p className="mt-3 text-sm text-amber">
          Imported evidence is supplied by a file. Its confirmation and receipt claims have not been
          independently verified by this device.
        </p>
      )}
      {r.context["omittedSteps"] ? (
        <p className="mt-3 text-sm text-amber">
          {String(r.context["omittedSteps"])} steps exceed the detail limit. The action status
          reflects the full sequence.
        </p>
      ) : null}
      {r.postState.length > 0 && (
        <div className="mt-3">
          <p className="station-code text-cream/60">Transaction metadata reads</p>
          {r.postState.map((p) => (
            <div key={p.signature} className="mt-1 border border-line p-2 text-sm">
              <p className="station-code text-amber">
                {p.slot === null
                  ? "Metadata unavailable — balance changes unverified"
                  : r.provenance === "import"
                    ? "Imported receipt claim"
                    : "Confirmed transaction metadata"}
              </p>
              <p>
                {shortAddr(p.signature)} · slot {p.slot ?? "—"} · fee {p.feeLamports ?? "—"}{" "}
                lamports{p.err ? ` · failed: ${p.err}` : ""}
              </p>
              <p>
                SOL change:{" "}
                {p.solDeltaLamports !== null
                  ? `${formatUnits(BigInt(p.solDeltaLamports), 9, 9)} SOL`
                  : "—"}
              </p>
              {p.tokenDeltas.map((t) => (
                <p key={t.mint}>
                  {shortAddr(t.mint)}: {formatUnits(BigInt(t.delta), t.decimals, t.decimals)}
                </p>
              ))}
              <p className="text-xs text-cream/60">{p.note}</p>
            </div>
          ))}
        </div>
      )}
      {r.kind === "wallet-action" && r.status === "confirmed" && !r.postState.length && (
        <p className="mt-3 text-sm text-amber">
          Transaction confirmed; post-state not yet verified.
        </p>
      )}
      <div className="mt-3">
        <p className="station-code text-cream/60">Timeline</p>
        <ol className="max-h-64 overflow-y-auto text-sm">
          {r.timeline.map((t, i) => (
            <li key={i} className="border-t border-line py-1">
              <span className="station-code text-cream/60">
                {new Date(t.at).toLocaleTimeString()}
              </span>{" "}
              <strong>{t.event}</strong> — {t.detail}
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-4">
        <Btn size="sm" variant="ghost" onClick={onDelete}>
          Delete from this device
        </Btn>
      </div>
    </Panel>
  );
}

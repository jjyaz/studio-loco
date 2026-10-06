import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Signer, Transaction } from "@solana/web3.js";
import { assertCluster, browserPendingStore, checkSignature, UNSUPPORTED_WALLET, runSequence, summarize, TERMINAL_PHASES, type PendingTx, type TxStep } from "@/lib/tx";
import { explorerTx, shortAddr } from "@/lib/format";
import { useSettings, type Cluster } from "@/lib/settings";
import { cn } from "@/lib/utils";

export function useTxRunner() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { settings } = useSettings();
  const [steps, setSteps] = useState<TxStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  const [ranCluster, setRanCluster] = useState<Cluster>(settings.cluster);
  // live identity, read by the guard before every signature in a sequence
  const live = useRef({ wallet: "", cluster: settings.cluster as string, rpc: "" });
  live.current = { wallet: wallet.publicKey?.toBase58() ?? "", cluster: settings.cluster, rpc: settings.rpc[settings.cluster] ?? "" };
  const canSign = !!wallet.publicKey && !!wallet.signTransaction;
  async function run(list: { label: string; tx: Transaction; signers?: Signer[] }[], extra: { semanticGuard?: () => string | null; maxFeeLamports?: number } = {}): Promise<TxStep[]> {
    if (!wallet.publicKey) throw new Error("Connect a wallet first");
    if (!wallet.signTransaction) throw new Error(UNSUPPORTED_WALLET);
    if (lock.current) throw new Error("Another transaction is already in progress");
    if (list.length === 0) { setSteps([]); return []; }
    lock.current = true;
    setRunning(true);
    const start = { ...live.current };
    setRanCluster(settings.cluster);
    try {
      return await runSequence({
        connection,
        wallet: { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
        steps: list,
        onUpdate: setSteps,
        ctx: { cluster: settings.cluster, rpc: settings.rpc[settings.cluster] ? "custom" : "relay", store: browserPendingStore, ...extra,
          identityGuard: () => {
            const n = live.current;
            if (n.wallet !== start.wallet) return "The connected wallet changed during this sequence, so remaining steps were stopped.";
            if (n.cluster !== start.cluster || n.rpc !== start.rpc) return "The network or RPC changed during this sequence, so remaining steps were stopped.";
            return null;
          } },
      });
    } finally {
      lock.current = false;
      setRunning(false);
    }
  }
  return { run, steps, running, canSign, ranCluster, reset: () => setSteps(null) };
}

const PHASE_TEXT: Record<TxStep["phase"], string> = {
  idle: "Waiting",
  preparing: "Fetching blockhash",
  simulating: "Simulating exact message",
  "awaiting-signature": "Approve in your wallet",
  sending: "Broadcasting",
  confirming: "Confirming onchain",
  confirmed: "Confirmed",
  failed: "Failed",
  rejected: "Declined in wallet",
  expired: "Expired — did not land",
  unknown: "Settlement unknown",
  skipped: "Not run",
};

export function TxSteps({ steps }: { steps: TxStep[] | null }) {
  const { settings } = useSettings();
  if (!steps) return null;
  const sum = summarize(steps);
  const done = steps.length === 0 || steps.every((s) => TERMINAL_PHASES.includes(s.phase));
  return (
    <div className="mt-4 border border-line p-4" aria-live="polite">
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{i + 1}. {s.label}</span>
              <span className={cn("station-code", s.phase === "confirmed" && "text-success", (s.phase === "failed" || s.phase === "rejected" || s.phase === "expired") && "text-destructive", (s.phase === "awaiting-signature" || s.phase === "unknown") && "text-amber")}>
                {PHASE_TEXT[s.phase]}
              </span>
            </div>
            {s.signature && (
              <a className="station-code text-amber underline" href={explorerTx(s.signature, ((s.cluster ?? s.pending?.cluster) === "devnet" ? "devnet" : "mainnet-beta") as Cluster)} target="_blank" rel="noreferrer">
                View on explorer ↗
              </a>
            )}
            {s.error && <p className="mt-1 break-words text-xs text-destructive">{s.error}</p>}
            {s.phase === "unknown" && s.pending && <CheckStatus p={s.pending} />}
            {s.logs && s.logs.length > 0 && (
              <details className="mt-1 text-xs text-cream/70">
                <summary className="cursor-pointer">Simulation logs</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{s.logs.slice(-20).join("\n")}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
      {done && <p className={cn("mt-3 text-sm font-medium", sum.kind === "success" ? "text-success" : sum.kind === "partial" || sum.kind === "unknown" ? "text-amber" : sum.kind === "none" ? "text-cream/70" : "text-destructive")}>{sum.text}</p>}
    </div>
  );
}

/** Reconcile one unresolved signature through the real RPC. Never resends. */
export function CheckStatus({ p, onResolved }: { p: PendingTx; onResolved?: () => void }) {
  const { connection } = useConnection();
  const { settings } = useSettings();
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrongCluster = p.cluster !== settings.cluster;
  async function check() {
    setBusy(true);
    try {
      try { await assertCluster(connection, p.cluster); }
      catch (e) { setState(e instanceof Error ? e.message : "Network check failed."); return; }
      const r = await checkSignature(connection, p.signature, p.lastValidBlockHeight);
      if (r.kind === "confirmed") {
        browserPendingStore.remove(p.signature);
        setState(r.err ? `Landed but FAILED onchain: ${JSON.stringify(r.err)}` : "Confirmed onchain.");
        onResolved?.();
      } else if (r.kind === "expired") {
        browserPendingStore.remove(p.signature);
        setState("Expired and absent from cluster history — it did not land.");
        onResolved?.();
      } else if (r.kind === "pending") setState("Still pending; blockhash has not expired yet. Check again shortly.");
      else setState(`Still unknown: ${r.reason}.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="station-code min-h-9 border border-amber px-3 text-amber disabled:opacity-50" onClick={check} disabled={busy || wrongCluster}>
        {busy ? "Checking…" : "Check status"}
      </button>
      {wrongCluster && <span className="text-cream/70">Switch to {p.cluster} to check this signature.</span>}
      {state && <span className="text-cream/85">{state}</span>}
    </div>
  );
}

/** Lists unresolved signatures that survived a reload. */
export function PendingTxList() {
  const [items, setItems] = useState<PendingTx[]>([]);
  const { settings } = useSettings();
  useEffect(() => {
    const load = () => setItems(browserPendingStore.list());
    load();
    window.addEventListener("studio-loco:pending", load);
    window.addEventListener("storage", load);
    return () => { window.removeEventListener("studio-loco:pending", load); window.removeEventListener("storage", load); };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="mb-6 border border-amber p-4" role="status">
      <p className="station-code text-amber">Unresolved transactions · {items.length}</p>
      <p className="mt-1 text-xs text-cream/75">These were broadcast but settlement wasn't confirmed. Check status before retrying anything.</p>
      <ul className="mt-3 flex flex-col gap-3">
        {items.map((p) => (
          <li key={p.signature} className="text-sm">
            <span>{p.label}</span> · <span className="font-mono text-xs">{shortAddr(p.signature, 6)}</span> · <span className="station-code text-cream/65">{p.cluster as Cluster}</span>{" "}
            <a className="station-code text-amber underline" href={explorerTx(p.signature, (p.cluster === "devnet" ? "devnet" : "mainnet-beta") as Cluster)} target="_blank" rel="noreferrer">Explorer ↗</a>
            <CheckStatus p={p} />
            {p.cluster !== settings.cluster && null}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Signer, Transaction } from "@solana/web3.js";
import {
  assertCluster,
  browserPendingStore,
  checkSignature,
  UNSUPPORTED_WALLET,
  runSequence,
  summarize,
  TERMINAL_PHASES,
  type PendingTx,
  type TxStep,
} from "@/lib/tx";
import { explorerTx, shortAddr } from "@/lib/format";
import { useSettings, type Cluster } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { noServerTransaction, txCoordinator } from "@/lib/tx-coordinator";
import { reconcileSignature, startWalletRecord, type Evidence } from "@/lib/recorder-store";
import { deltasFromMeta, redact } from "@/lib/recorder";
import type { Connection } from "@solana/web3.js";

/** Separate verified post-state read from confirmed transaction metadata. Bounded; failure is recorded as unavailable. */
async function verifyPostState(connection: Connection, wallet: string, signature: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const t = await Promise.race([
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      new Promise<null>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timed out")), 12_000);
      }),
    ]);
    if (!t || !t.meta)
      return {
        verifiedAt: Date.now(),
        source: "getTransaction" as const,
        signature,
        slot: null,
        err: null,
        feeLamports: null,
        solDeltaLamports: null,
        tokenDeltas: [],
        note: "Transaction metadata not available from this RPC yet — post-state unverified.",
      };
    const accountKeys = t.transaction.message.getAccountKeys({
      accountKeysFromLookups: t.meta.loadedAddresses,
    });
    const keys = Array.from({ length: accountKeys.length }, (_, i) =>
      accountKeys.get(i)!.toBase58(),
    );
    const tok = (xs: typeof t.meta.preTokenBalances) =>
      (xs ?? []).map((b) => ({
        owner: b.owner,
        mint: b.mint,
        amount: b.uiTokenAmount.amount,
        decimals: b.uiTokenAmount.decimals,
      }));
    const d = deltasFromMeta({
      wallet,
      accountKeys: keys,
      preBalances: t.meta.preBalances,
      postBalances: t.meta.postBalances,
      fee: t.meta.fee,
      preToken: tok(t.meta.preTokenBalances),
      postToken: tok(t.meta.postTokenBalances),
    });
    return {
      verifiedAt: Date.now(),
      source: "getTransaction" as const,
      signature,
      slot: Number.isSafeInteger(t.slot) ? t.slot : null,
      err: t.meta.err ? redact(JSON.stringify(t.meta.err)) : null,
      feeLamports: Number.isSafeInteger(t.meta.fee) ? t.meta.fee : null,
      ...d,
      note: "Wallet balance change from confirmed transaction metadata; unsafe numeric amounts are omitted. Not realized PnL or a separate position-state read.",
    };
  } catch (e) {
    return {
      verifiedAt: Date.now(),
      source: "getTransaction" as const,
      signature,
      slot: null,
      err: null,
      feeLamports: null,
      solDeltaLamports: null,
      tokenDeltas: [],
      note: redact(`Post-state read failed: ${e instanceof Error ? e.message : String(e)}`).slice(
        0,
        200,
      ),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useActiveTransaction() {
  return useSyncExternalStore(
    txCoordinator.subscribe,
    txCoordinator.getSnapshot,
    noServerTransaction,
  );
}

export function useTxRunner() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { settings } = useSettings();
  const [steps, setSteps] = useState<TxStep[] | null>(null);
  const active = useActiveTransaction();
  const mounted = useRef(false);
  const epoch = useRef(0);
  const [ranCluster, setRanCluster] = useState<Cluster>(settings.cluster);
  // live identity, read by the guard before every signature in a sequence
  const live = useRef({ wallet: "", cluster: settings.cluster as string, rpc: "" });
  const next = {
    wallet: wallet.publicKey?.toBase58() ?? "",
    cluster: settings.cluster,
    rpc: settings.rpc[settings.cluster] ?? "",
  };
  if (
    live.current.wallet !== next.wallet ||
    live.current.cluster !== next.cluster ||
    live.current.rpc !== next.rpc
  )
    epoch.current++;
  live.current = next;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // This is a live generation counter, not a DOM ref: invalidate its current value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
    };
  }, []);
  const canSign = !!wallet.publicKey && !!wallet.signTransaction;
  async function run(
    list: { label: string; tx: Transaction; signers?: Signer[] }[],
    extra: {
      semanticGuard?: () => string | null;
      maxFeeLamports?: number;
      evidence?: Evidence;
    } = {},
  ): Promise<TxStep[]> {
    if (!wallet.publicKey) throw new Error("Connect a wallet first");
    if (!wallet.signTransaction) throw new Error(UNSUPPORTED_WALLET);
    if (list.length === 0) {
      setSteps([]);
      return [];
    }
    const start = { ...live.current };
    const startedEpoch = epoch.current;
    const lease = txCoordinator.acquire({
      wallet: start.wallet,
      cluster: start.cluster,
      label: list[0]!.label,
    });
    setRanCluster(settings.cluster);
    const { evidence, ...guards } = extra;
    const rec = startWalletRecord({
      route: typeof window !== "undefined" ? window.location.pathname : "",
      cluster: settings.cluster,
      rpc: settings.rpc[settings.cluster] ? "custom" : "relay",
      wallet: start.wallet,
      labels: list.map((l) => l.label),
      evidence,
    });
    try {
      const out = await runSequence({
        connection,
        wallet: { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
        steps: list,
        onUpdate: (state) => {
          rec.update(state);
          if (mounted.current) setSteps(state);
          const current = state.find(
            (s) => s.phase !== "idle" && !TERMINAL_PHASES.includes(s.phase),
          );
          if (current) lease.update(current.label, current.phase);
        },
        ctx: {
          cluster: settings.cluster,
          rpc: settings.rpc[settings.cluster] ? "custom" : "relay",
          store: browserPendingStore,
          ...guards,
          identityGuard: () => {
            if (!mounted.current)
              return "This review's page was closed. The old approval was discarded; open a fresh review.";
            if (epoch.current !== startedEpoch)
              return "Wallet, network or RPC changed after this action started. Open a fresh review.";
            const n = live.current;
            if (n.wallet !== start.wallet)
              return "The connected wallet changed during this sequence, so remaining steps were stopped.";
            if (n.cluster !== start.cluster || n.rpc !== start.rpc)
              return "The network or RPC changed during this sequence, so remaining steps were stopped.";
            return null;
          },
        },
      });
      const confirmed = out.filter((s) => s.phase === "confirmed" && s.signature);
      await rec.flush();
      void (async () => {
        for (const s of confirmed)
          await rec.addPostState(await verifyPostState(connection, start.wallet, s.signature!));
      })().catch(() => {});
      return out;
    } finally {
      lease.release();
    }
  }
  return { run, steps, running: !!active, canSign, ranCluster, reset: () => setSteps(null) };
}

export function ActiveTxNotice() {
  const active = useActiveTransaction();
  if (!active) return null;
  return (
    <div className="mb-6 border border-amber p-4 text-sm" role="status">
      <p className="station-code text-amber">Wallet action in progress · {active.cluster}</p>
      <p className="mt-2 break-words">
        {active.label} · {PHASE_TEXT[active.phase]}
      </p>
      <p className="mt-1 text-xs text-cream/75">
        Other wallet actions wait until this request settles. Changing pages invalidates an approval
        that has not been sent; already-broadcast transactions still need confirmation.
      </p>
    </div>
  );
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
              <span>
                {i + 1}. {s.label}
              </span>
              <span
                className={cn(
                  "station-code",
                  s.phase === "confirmed" && "text-success",
                  (s.phase === "failed" || s.phase === "rejected" || s.phase === "expired") &&
                    "text-destructive",
                  (s.phase === "awaiting-signature" || s.phase === "unknown") && "text-amber",
                )}
              >
                {PHASE_TEXT[s.phase]}
              </span>
            </div>
            {s.signature && (
              <a
                className="station-code text-amber underline"
                href={explorerTx(
                  s.signature,
                  ((s.cluster ?? s.pending?.cluster) === "devnet"
                    ? "devnet"
                    : "mainnet-beta") as Cluster,
                )}
                target="_blank"
                rel="noreferrer"
              >
                View on explorer ↗
              </a>
            )}
            {s.error && <p className="mt-1 break-words text-xs text-destructive">{s.error}</p>}
            {s.phase === "unknown" && s.pending && <CheckStatus p={s.pending} />}
            {s.logs && s.logs.length > 0 && (
              <details className="mt-1 text-xs text-cream/70">
                <summary className="cursor-pointer">Simulation logs</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
                  {s.logs.slice(-20).join("\n")}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ol>
      {done && (
        <p
          className={cn(
            "mt-3 text-sm font-medium",
            sum.kind === "success"
              ? "text-success"
              : sum.kind === "partial" || sum.kind === "unknown"
                ? "text-amber"
                : sum.kind === "none"
                  ? "text-cream/70"
                  : "text-destructive",
          )}
        >
          {sum.text}
        </p>
      )}
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
      try {
        await assertCluster(connection, p.cluster);
      } catch (e) {
        setState(e instanceof Error ? e.message : "Network check failed.");
        return;
      }
      const r = await checkSignature(connection, p.signature, p.lastValidBlockHeight);
      await reconcileSignature(
        p.signature,
        r.kind === "confirmed"
          ? r.err
            ? "failed"
            : "confirmed"
          : r.kind === "expired"
            ? "expired"
            : r.kind === "pending"
              ? "pending"
              : "unknown",
        r.kind === "unknown"
          ? r.reason
          : r.kind === "confirmed" && r.err
            ? JSON.stringify(r.err)
            : r.kind,
        p,
      );
      if (r.kind === "confirmed") {
        browserPendingStore.remove(p.signature);
        setState(
          r.err ? `Landed but FAILED onchain: ${JSON.stringify(r.err)}` : "Confirmed onchain.",
        );
        onResolved?.();
      } else if (r.kind === "expired") {
        browserPendingStore.remove(p.signature);
        setState("Expired and absent from cluster history — it did not land.");
        onResolved?.();
      } else if (r.kind === "pending")
        setState("Still pending; blockhash has not expired yet. Check again shortly.");
      else setState(`Still unknown: ${r.reason}.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        className="station-code min-h-9 border border-amber px-3 text-amber disabled:opacity-50"
        onClick={check}
        disabled={busy || wrongCluster}
      >
        {busy ? "Checking…" : "Check status"}
      </button>
      {wrongCluster && (
        <span className="text-cream/70">Switch to {p.cluster} to check this signature.</span>
      )}
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
    return () => {
      window.removeEventListener("studio-loco:pending", load);
      window.removeEventListener("storage", load);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className="mb-6 border border-amber p-4" role="status">
      <p className="station-code text-amber">Unresolved transactions · {items.length}</p>
      <p className="mt-1 text-xs text-cream/75">
        These were broadcast but settlement wasn't confirmed. Check status before retrying anything.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {items.map((p) => (
          <li key={p.signature} className="text-sm">
            <span>{p.label}</span> ·{" "}
            <span className="font-mono text-xs">{shortAddr(p.signature, 6)}</span> ·{" "}
            <span className="station-code text-cream/65">{p.cluster as Cluster}</span>{" "}
            <a
              className="station-code text-amber underline"
              href={explorerTx(
                p.signature,
                (p.cluster === "devnet" ? "devnet" : "mainnet-beta") as Cluster,
              )}
              target="_blank"
              rel="noreferrer"
            >
              Explorer ↗
            </a>
            <CheckStatus p={p} />
            {p.cluster !== settings.cluster && null}
          </li>
        ))}
      </ul>
    </div>
  );
}

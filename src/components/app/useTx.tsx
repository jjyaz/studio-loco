import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Signer, Transaction } from "@solana/web3.js";
import { runSequence, summarize, type TxStep } from "@/lib/tx";
import { explorerTx } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

export function useTxRunner() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [steps, setSteps] = useState<TxStep[] | null>(null);
  const [running, setRunning] = useState(false);
  async function run(list: { label: string; tx: Transaction; signers?: Signer[] }[]) {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet first");
    setRunning(true);
    try {
      return await runSequence({ connection, wallet: { publicKey: wallet.publicKey, sendTransaction: wallet.sendTransaction }, steps: list, onUpdate: setSteps });
    } finally {
      setRunning(false);
    }
  }
  return { run, steps, running, reset: () => setSteps(null) };
}

const PHASE_TEXT: Record<TxStep["phase"], string> = {
  idle: "Waiting",
  preparing: "Fetching blockhash",
  simulating: "Simulating on RPC",
  "awaiting-signature": "Approve in your wallet",
  sending: "Sending",
  confirming: "Confirming onchain",
  confirmed: "Confirmed",
  failed: "Failed",
  rejected: "Declined in wallet",
  skipped: "Not run",
};

export function TxSteps({ steps }: { steps: TxStep[] | null }) {
  const { settings } = useSettings();
  if (!steps) return null;
  const sum = summarize(steps);
  const done = steps.every((s) => ["confirmed", "failed", "rejected", "skipped"].includes(s.phase));
  return (
    <div className="mt-4 border border-line p-4" aria-live="polite">
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => (
          <li key={i} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{i + 1}. {s.label}</span>
              <span className={cn("station-code", s.phase === "confirmed" && "text-success", (s.phase === "failed" || s.phase === "rejected") && "text-destructive", s.phase === "awaiting-signature" && "text-amber")}>
                {PHASE_TEXT[s.phase]}
              </span>
            </div>
            {s.signature && (
              <a className="station-code text-amber underline" href={explorerTx(s.signature, settings.cluster)} target="_blank" rel="noreferrer">
                View on explorer ↗
              </a>
            )}
            {s.error && <p className="mt-1 break-words text-xs text-destructive">{s.error}</p>}
            {s.logs && s.logs.length > 0 && (
              <details className="mt-1 text-xs text-cream/70">
                <summary className="cursor-pointer">Simulation logs</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">{s.logs.slice(-20).join("\n")}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
      {done && <p className={cn("mt-3 text-sm font-medium", sum.kind === "success" ? "text-success" : sum.kind === "partial" ? "text-amber" : "text-destructive")}>{sum.text}</p>}
    </div>
  );
}

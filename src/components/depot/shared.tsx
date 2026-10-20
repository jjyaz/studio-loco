import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { useDepotServerFn as useServerFn } from "./auth";
import { Btn, Notice } from "@/components/kit";
import { useSettings } from "@/lib/settings";
import { formatUnits } from "@/lib/amount";
import { requestWalletChallenge, verifyWalletChallenge } from "@/lib/depot.functions";
import type { ScoutReportDTO } from "@/lib/depot-contracts";
import { proofMessage } from "@/lib/depot-contracts";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

export const fmtRaw = (raw: string | null | undefined, decimals: number) => {
  if (raw == null) return "—";
  try {
    return formatUnits(raw, decimals);
  } catch {
    return "—";
  }
};

/**
 * Monotonic in-memory generation for the exact connection identity. Increments whenever the
 * connection object, endpoint, wallet, network or practice mode changes; reviews bind to it.
 */
export function useRpcGeneration() {
  const { connection } = useConnection();
  const { settings, endpoint } = useSettings();
  const wallet = useWallet();
  const gen = useRef(0);
  const last = useRef<unknown[]>([]);
  const now = [connection, endpoint, settings.cluster, settings.practice, wallet.publicKey?.toBase58() ?? ""];
  if (now.some((v, i) => v !== last.current[i])) {
    gen.current++;
    last.current = now;
  }
  return gen.current;
}

/** Live remaining-seconds countdown for a 20s review. */
export function useCountdown(createdAt: number | null, ttlMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (createdAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [createdAt]);
  if (createdAt === null) return null;
  return Math.max(0, Math.ceil((createdAt + ttlMs - now) / 1000));
}

export function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Btn
      size="sm"
      variant="ghost"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </Btn>
  );
}

export function Addr({ a, label }: { a: string | null | undefined; label: string }) {
  if (!a) return <span className="font-mono text-cream/60">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <a
        className="font-mono text-cream underline decoration-line underline-offset-4 hover:text-amber"
        href={`https://solscan.io/account/${a}`}
        target="_blank"
        rel="noreferrer"
        title={a}
      >
        {shortAddr(a, 6)}
      </a>
      <Copy text={a} label={label} />
    </span>
  );
}

/** Wallet-control proof: server challenge → wallet.signMessage over the exact text → server verification. */
export function WalletProof({
  agentId,
  purpose,
  onVerified,
  disabledReason,
}: {
  agentId: string;
  purpose: "controller" | "viewer";
  onVerified: (wallet: string) => void;
  disabledReason?: string | null;
}) {
  const wallet = useWallet();
  const ask = useServerFn(requestWalletChallenge);
  const verify = useServerFn(verifyWalletChallenge);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const pk = wallet.publicKey?.toBase58();
  const live = useRef({ pk, agentId, purpose, epoch: 0 });
  if (live.current.pk !== pk || live.current.agentId !== agentId || live.current.purpose !== purpose) live.current = { pk, agentId, purpose, epoch: live.current.epoch + 1 };
  useEffect(() => () => { live.current.epoch++; }, []);
  async function go() {
    if (!pk || !wallet.signMessage) return;
    setBusy(true);
    setMsg(null);
    const epoch = live.current.epoch;
    const current = () => { if (live.current.epoch !== epoch || live.current.pk !== pk) throw new Error("Wallet or agent changed; request a new proof."); };
    try {
      const c = await ask({ data: { agentId, wallet: pk, purpose } });
      if (!c.ok) throw new Error(c.error);
      current();
      if (c.message !== proofMessage(c.challenge) || c.challenge.wallet !== pk || c.challenge.agentId !== agentId || c.challenge.purpose !== purpose || c.challenge.domain !== window.location.host) throw new Error("Wallet challenge does not match this site, agent and wallet.");
      const sig = await wallet.signMessage(new TextEncoder().encode(c.message));
      current();
      const v = await verify({ data: { agentId, wallet: pk, purpose, nonce: c.challenge.nonce, signature: bs58.encode(sig) } });
      if (!v.ok) throw new Error(v.error);
      current();
      setMsg({ tone: "info", text: `Wallet ${shortAddr(pk, 6)} proven.` });
      onVerified(pk);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  const reason = disabledReason ?? (!pk ? "Connect a wallet first." : !wallet.signMessage ? "This wallet cannot sign messages." : null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Btn onClick={go} disabled={busy || !!reason}>
          {busy ? "Waiting for wallet…" : purpose === "controller" ? "Prove wallet control" : "Prove holder wallet"}
        </Btn>
        {reason && <span className="text-xs text-cream/70">{reason}</span>}
      </div>
      <p className="text-xs text-cream/60">
        Signs a one-time text message bound to this site, agent, wallet and a 5-minute nonce. It does not approve any
        transaction. Your sign-in is never treated as wallet control.
      </p>
      {msg && <Notice tone={msg.tone} title={msg.text} />}
    </div>
  );
}

export function ScoutReportView({ r }: { r: ScoutReportDTO }) {
  const f = r.facts;
  return (
    <article className="border border-line bg-midnight/60 p-4" aria-label="Scout report">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="station-code text-amber">Scout · measured read</p>
        <p className="station-code text-cream/65">
          slot {f.slot} · {new Date(f.observedAt).toISOString().replace("T", " ").slice(0, 19)} UTC · {f.readMs} ms
        </p>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="station-code text-cream/60">Pool</dt><dd><Addr a={f.pool} label="pool" /></dd></div>
        <div><dt className="station-code text-cream/60">Bin step · active bin</dt><dd className="font-mono">{f.binStep} · {f.activeId}</dd></div>
        <div><dt className="station-code text-cream/60">Token X ({f.decimalsX} dp)</dt><dd><Addr a={f.mintX} label="mint X" /></dd></div>
        <div><dt className="station-code text-cream/60">Token Y ({f.decimalsY} dp)</dt><dd><Addr a={f.mintY} label="mint Y" /></dd></div>
        <div><dt className="station-code text-cream/60">Status</dt><dd className="font-mono">{f.enabled ? "enabled" : "disabled"} · {f.activated ? "activated" : "not activated"}</dd></div>
        <div><dt className="station-code text-cream/60">Source</dt><dd className="font-mono text-xs">{f.source} · {f.binArrays.length} bin arrays</dd></div>
      </dl>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Probe quotes</caption>
          <thead>
            <tr className="station-code text-left text-cream/60">
              <th className="py-1">Direction</th><th>Input</th><th>Consumed</th><th>Output</th><th>LP fee (raw)</th><th>Protocol fee (raw)</th>
            </tr>
          </thead>
          <tbody>
            {f.quotes.map((q, i) => {
              const [di, dout] = q.direction === "x-to-y" ? [f.decimalsX, f.decimalsY] : [f.decimalsY, f.decimalsX];
              return (
                <tr key={i} className="border-t border-line/50 font-mono tabular">
                  <td className="py-1.5">{q.direction}</td>
                  <td>{fmtRaw(q.inputRaw, di)}</td>
                  {q.status === "quoted" ? (
                    <>
                      <td className={cn(q.consumedRaw !== q.inputRaw && "text-amber")}>{fmtRaw(q.consumedRaw, di)}</td>
                      <td>{fmtRaw(q.outputRaw, dout)}</td>
                      <td>{q.lpFeeRaw}</td>
                      <td>{q.protocolFeeRaw}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="text-cream/70">Unavailable — {q.reason}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-cream/70">
        {f.gaps.map((g) => <li key={g}>{g}</li>)}
      </ul>
      {r.ai && (
        <div className="mt-4 border-l-4 border-ochre bg-muted px-3 py-2">
          <p className="station-code text-ochre">AI commentary · {r.ai.model ?? "—"} · not a measurement, not transaction authority</p>
          {r.ai.status === "ok" ? (
            <>
              <p className="mt-1 text-sm text-cream/85">{r.ai.brief}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-cream/75">
                {r.ai.observations?.map((o, i) => <li key={i}><span className="font-mono text-cream/55">[{o.factId}]</span> {o.note}</li>)}
              </ul>
            </>
          ) : (
            <p className="mt-1 text-sm text-cream/80">Commentary {r.ai.status}: {r.ai.reason}</p>
          )}
        </div>
      )}
    </article>
  );
}

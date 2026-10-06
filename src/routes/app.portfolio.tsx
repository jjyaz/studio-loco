import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import BN from "bn.js";
import { Btn, Cap, Notice, PageHead, Panel, Spinner } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { usePositions, rangeState, useIndexedPortfolio, type PositionRow } from "@/components/app/positions";
import { Field } from "@/components/kit";
import { fmtUsd } from "@/lib/format";
import { formatUnits } from "@/lib/amount";
import { getPool, invalidatePool } from "@/lib/dlmm";
import { shortAddr, timeAgo } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/portfolio")({
  head: () => ({
    meta: [
      { title: "Portfolio — Studio Loco" },
      { name: "description", content: "Your real Meteora DLMM positions, unclaimed fees and rewards, with claim and withdraw actions." },
      { property: "og:title", content: "Portfolio — Studio Loco" },
      { property: "og:description", content: "Read and manage your DLMM positions from your own wallet." },
    ],
  }),
  component: Portfolio,
});

type Action = { kind: "claim" } | { kind: "withdraw"; pct: number; close: boolean } | { kind: "close" };

function Portfolio() {
  const { publicKey } = useWallet();
  const q = usePositions();
  const [selected, setSelected] = useState<string[]>([]);
  const runner = useTxRunner();
  const { connection } = useConnection();
  const { settings } = useSettings();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  async function act(rows: PositionRow[], a: Action) {
    if (!publicKey) return;
    setErr(null);
    try {
      const steps: { label: string; tx: import("@solana/web3.js").Transaction }[] = [];
      for (const r of rows) {
        invalidatePool(r.pair);
        const pool = await getPool(connection, r.pair, settings.cluster);
        const tag = shortAddr(r.key);
        if (a.kind === "claim") {
          const fees = await pool.claimSwapFee({ owner: publicKey, position: r.position });
          fees.forEach((tx, i) => steps.push({ label: `Claim fees · ${tag}${fees.length > 1 ? ` (${i + 1}/${fees.length})` : ""}`, tx }));
          const hasRewards = !r.position.positionData.rewardOne.isZero() || !r.position.positionData.rewardTwo.isZero();
          if (hasRewards) {
            const rw = await pool.claimAllRewardsByPosition({ owner: publicKey, position: r.position });
            rw.forEach((tx, i) => steps.push({ label: `Claim rewards · ${tag} (${i + 1}/${rw.length})`, tx }));
          }
        } else if (a.kind === "withdraw") {
          const txs = await pool.removeLiquidity({ user: publicKey, position: r.position.publicKey, fromBinId: r.lower, toBinId: r.upper, bps: new BN(a.pct * 100), shouldClaimAndClose: a.close });
          txs.forEach((tx, i) => steps.push({ label: `${a.close ? "Remove, claim & close" : `Withdraw ${a.pct}%`} · ${tag}${txs.length > 1 ? ` (${i + 1}/${txs.length})` : ""}`, tx }));
        } else {
          steps.push({ label: `Close empty position · ${tag}`, tx: await pool.closePosition({ owner: publicKey, position: r.position }) });
        }
      }
      if (steps.length === 0) { setErr("Nothing to do for the selected positions."); return; }
      await runner.run(steps);
    } catch (e) {
      setErr(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      qc.invalidateQueries({ queryKey: ["positions"] });
    }
  }

  return (
    <div>
      <PageHead code="ST-04 · Portfolio" title="Your carriages." intro="DLMM positions owned by your connected wallet. On mainnet they are found through Meteora's index, then every position is checked on chain before any action is offered." cap={["live"]}>
        {publicKey && <div className="flex items-center gap-3"><span className="station-code text-cream/70">{q.dataUpdatedAt ? `Updated ${timeAgo(q.dataUpdatedAt)}` : "—"}</span><Btn size="sm" variant="line" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? "Refreshing…" : "Refresh"}</Btn></div>}
      </PageHead>
      {!publicKey && <Panel><p className="mb-4 text-cream/80">Connect a wallet to read your positions. Nothing is shown until you do.</p><WalletButton /></Panel>}
      {publicKey && q.isPending && <Spinner label="Scanning DLMM positions" />}
      {q.isError && (
        <Notice tone="error" title="Couldn't read positions" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>
          {redactUrls(String(((q.error) as Error)?.message ?? ""))}. {settings.cluster === "mainnet-beta" ? "Mainnet positions are found through Meteora's index, then each one is checked on chain." : "Devnet positions are found by scanning the chain, which some RPCs restrict — try a dedicated RPC in Settings."} This is an error, not an empty portfolio.
        </Notice>
      )}
      {q.data?.report && (q.data.report.rejected > 0 || q.data.report.truncated) && (
        <div className="mb-4"><Notice tone="warn" title="Portfolio may be incomplete">
          {q.data.report.rejected > 0 && <>{q.data.report.rejected} indexed position{q.data.report.rejected === 1 ? "" : "s"} failed on-chain verification (wrong program, account type, pool or owner) and {q.data.report.rejected === 1 ? "is" : "are"} hidden. </>}
          {q.data.report.truncated && <>The index returned more positions than this page reads ({q.data.report.indexedTotal ?? "—"} reported); only the first pages are shown. </>}
        </Notice></div>
      )}
      {q.data && q.data.length === 0 && <Panel><p className="text-cream/80">{q.data.report?.rejected || q.data.report?.truncated ? "No verified positions to show." : <>No DLMM positions found for {shortAddr(publicKey?.toBase58())} on this cluster.</>}</p><Link to="/app" className="mt-3 inline-block underline">Find a pool →</Link></Panel>}
      {q.data && q.data.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Btn size="sm" disabled={!selected.length || runner.running} onClick={() => act(q.data!.filter((r) => selected.includes(r.key)), { kind: "claim" })}>Claim selected ({selected.length})</Btn>
            <p className="self-center text-xs text-cream/65">No USD total is shown: we don't fabricate prices for every token.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {q.data.map((r) => <PositionCard key={r.key} r={r} selected={selected.includes(r.key)} onSelect={(v) => setSelected((s) => (v ? [...s, r.key] : s.filter((k) => k !== r.key)))} onAct={(a) => act([r], a)} busy={runner.running} />)}
          </div>
        </>
      )}
      {err && <div className="mt-4"><Notice tone="error" title="Couldn't prepare transactions">{err}</Notice></div>}
      <TxSteps steps={runner.steps} />
      {settings.cluster === "mainnet-beta" && <WatchIndexed connected={publicKey?.toBase58() ?? null} />}
    </div>
  );
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Indexed public readings for any address. Read-only: no actions, never feeds transaction amounts. */
function WatchIndexed({ connected }: { connected: string | null }) {
  const [input, setInput] = useState("");
  const [addr, setAddr] = useState<string | null>(null);
  const target = addr ?? connected;
  const q = useIndexedPortfolio(target);
  const bad = input.trim() !== "" && !B58.test(input.trim());
  return (
    <section className="mt-10" aria-labelledby="watch-h">
      <h2 id="watch-h" className="display text-2xl">Indexed readings</h2>
      <p className="mt-1 max-w-2xl text-sm text-cream/75">Approximate values from Meteora's public mainnet index. Read-only: you can't act on them here, and they're never used to work out transaction amounts. Enter any address to watch it.</p>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (!bad && input.trim()) setAddr(input.trim()); }}>
        <div className="min-w-0 flex-1 sm:max-w-md"><Field label="Watch address (read-only)" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Solana address" spellCheck={false} /></div>
        <Btn size="sm" type="submit" disabled={bad || !input.trim()}>Watch</Btn>
        {addr && connected && <Btn size="sm" variant="line" type="button" onClick={() => { setAddr(null); setInput(""); }}>Back to my wallet</Btn>}
      </form>
      {bad && <p role="alert" className="mt-2 text-sm text-destructive">That isn't a valid Solana address.</p>}
      {!target && <p className="mt-4 text-sm text-cream/70">Connect a wallet or enter an address.</p>}
      {target && q.isPending && <Spinner label="Reading the index" />}
      {q.isError && <div className="mt-4"><Notice tone="error" title="Index unavailable" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>{redactUrls((q.error as Error).message)}</Notice></div>}
      {q.data && (
        <div className="mt-4">
          <p className="station-code text-cream/65">{shortAddr(target)} · {addr ? "watch-only" : "your wallet"} · indexed {timeAgo(q.data.fetchedAt)} · {q.data.totalPositions ?? "—"} open positions</p>
          {q.data.pools.length === 0 ? <p className="mt-3 text-sm text-cream/75">The index lists no open DLMM positions for this address.</p> : (
            <div className="mt-3 overflow-x-auto border border-line">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="border-b border-line text-left station-code text-cream/70"><th className="p-3">Pool</th><th className="p-3 text-right">Positions</th><th className="p-3 text-right">Out of range</th><th className="p-3 text-right">Balance ≈</th><th className="p-3 text-right">Unclaimed fees ≈</th><th className="p-3 text-right">PnL ≈</th></tr></thead>
                <tbody>
                  {q.data.pools.map((p) => (
                    <tr key={p.poolAddress} className="border-b border-line/60">
                      <td className="p-3"><Link to="/app/pool/$address" params={{ address: p.poolAddress }} className="hover:text-amber">{p.tokenX && p.tokenY ? `${p.tokenX}-${p.tokenY}` : shortAddr(p.poolAddress)}</Link>{p.poolStateUpdatedAtBlockTime ? <span className="block station-code text-cream/55">pool state {timeAgo(p.poolStateUpdatedAtBlockTime * 1000)}</span> : null}</td>
                      <td className="p-3 text-right font-mono">{p.openPositionCount ?? p.listPositions.length}</td>
                      <td className="p-3 text-right font-mono">{p.positionsOutOfRange ?? "—"}</td>
                      <td className="p-3 text-right font-mono">{fmtUsd(p.balances)}</td>
                      <td className="p-3 text-right font-mono">{fmtUsd(p.unclaimedFees)}</td>
                      <td className="p-3 text-right font-mono">{fmtUsd(p.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3"><Cap kind="live" /></div>
        </div>
      )}
    </section>
  );
}

function PositionCard({ r, selected, onSelect, onAct, busy }: { r: PositionRow; selected: boolean; onSelect: (v: boolean) => void; onAct: (a: Action) => void; busy: boolean }) {
  const d = r.position.positionData;
  const [pct, setPct] = useState(50);
  const st = rangeState(r.activeId, r.lower, r.upper, 0);
  const empty = new BN(d.totalXAmount.split(".")[0] || "0").isZero() && new BN(d.totalYAmount.split(".")[0] || "0").isZero();
  return (
    <Panel>
      <div className="flex items-start justify-between gap-3">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="size-5 accent-[var(--amber)]" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select position ${r.key}`} />
          <span>
            <Link to="/app/pool/$address" params={{ address: r.pair }} className="font-medium hover:text-amber">Pool {shortAddr(r.pair)}</Link>
            <span className="block station-code text-cream/60">Position {shortAddr(r.key)}</span>
          </span>
        </label>
        <span className={cn("station-code border px-2 py-1", st === "in-range" ? "border-success text-success" : "border-destructive text-destructive")}>{st === "in-range" ? "In range" : "Out of range"}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-cream/65">Bins</dt><dd className="font-mono">{r.lower} → {r.upper} (active {r.activeId})</dd>
        <dt className="text-cream/65">Holding X</dt><dd className="font-mono">{formatUnits(d.totalXAmount.split(".")[0] ?? "0", r.decX, 6)}</dd>
        <dt className="text-cream/65">Holding Y</dt><dd className="font-mono">{formatUnits(d.totalYAmount.split(".")[0] ?? "0", r.decY, 6)}</dd>
        <dt className="text-cream/65">Unclaimed fee X</dt><dd className="font-mono">{formatUnits(d.feeX, r.decX, 6)}</dd>
        <dt className="text-cream/65">Unclaimed fee Y</dt><dd className="font-mono">{formatUnits(d.feeY, r.decY, 6)}</dd>
        <dt className="text-cream/65">Rewards (raw)</dt><dd className="font-mono">{d.rewardOne.toString()} / {d.rewardTwo.toString()}</dd>
      </dl>
      <p className="mt-2 text-xs text-cream/55">X {shortAddr(r.mintX)} · Y {shortAddr(r.mintY)}</p>
      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
        <Btn size="sm" variant="quiet" disabled={busy} onClick={() => onAct({ kind: "claim" })}>Claim fees & rewards</Btn>
        <div className="flex items-center gap-3">
          <label htmlFor={`pct-${r.key}`} className="station-code w-28">Withdraw {pct}%</label>
          <input id={`pct-${r.key}`} type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="flex-1 accent-[var(--amber)]" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn size="sm" variant="line" disabled={busy || empty} onClick={() => onAct({ kind: "withdraw", pct, close: false })}>Withdraw {pct}%</Btn>
          <Btn size="sm" variant="danger" disabled={busy} onClick={() => onAct(empty ? { kind: "close" } : { kind: "withdraw", pct: 100, close: true })}>{empty ? "Close position" : "Remove all, claim & close"}</Btn>
        </div>
      </div>
      <div className="mt-3"><Cap kind="live" /></div>
    </Panel>
  );
}

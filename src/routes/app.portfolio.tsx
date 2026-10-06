import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import BN from "bn.js";
import { Btn, Cap, Notice, PageHead, Panel, Spinner } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { usePositions, rangeState, type PositionRow } from "@/components/app/positions";
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      qc.invalidateQueries({ queryKey: ["positions"] });
    }
  }

  return (
    <div>
      <PageHead code="ST-04 · Portfolio" title="Your carriages." intro="DLMM positions owned by your connected wallet, read directly from chain." cap={["live"]}>
        {publicKey && <div className="flex items-center gap-3"><span className="station-code text-cream/70">{q.dataUpdatedAt ? `Updated ${timeAgo(q.dataUpdatedAt)}` : "—"}</span><Btn size="sm" variant="line" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? "Refreshing…" : "Refresh"}</Btn></div>}
      </PageHead>
      {!publicKey && <Panel><p className="mb-4 text-cream/80">Connect a wallet to read your positions. Nothing is shown until you do.</p><WalletButton /></Panel>}
      {publicKey && q.isPending && <Spinner label="Scanning DLMM positions" />}
      {q.isError && (
        <Notice tone="error" title="Couldn't read positions" action={<Btn size="sm" onClick={() => q.refetch()}>Retry</Btn>}>
          {redactUrls(String(((q.error) as Error)?.message ?? ""))}. Position scans use getProgramAccounts, which public RPCs often restrict — set a dedicated RPC in Settings. This is an error, not an empty portfolio.
        </Notice>
      )}
      {q.data && q.data.length === 0 && <Panel><p className="text-cream/80">No DLMM positions found for {shortAddr(publicKey?.toBase58())} on this cluster.</p><Link to="/app" className="mt-3 inline-block underline">Find a pool →</Link></Panel>}
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
    </div>
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

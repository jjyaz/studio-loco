import { useEffect, useRef, useState } from "react";
import { useDepotServerFn as useServerFn } from "./auth";
import { useWallet } from "@solana/wallet-adapter-react";
import { Btn, Notice, Panel, Spinner } from "@/components/kit";
import { DepotWalletSignIn as AccountPanel, useDepotWalletSession as useCloudSession } from "./auth";
import { WalletButton } from "@/components/wallet/WalletButton";
import { listGatedReports } from "@/lib/depot.functions";
import type { ScoutReportDTO } from "@/lib/depot-contracts";
import { ScoutReportView, WalletProof } from "./shared";

/** Protected report state belongs to one account/wallet/agent epoch; never reuse across identities. */
export function GatedReports({ id }: { id: string }) {
  const s = useCloudSession(), wallet = useWallet(), list = useServerFn(listGatedReports);
  const pk = wallet.publicKey?.toBase58() ?? "";
  const scope = JSON.stringify([id, s.userId, pk]);
  const live = useRef({ scope, epoch: 0 });
  if (live.current.scope !== scope) live.current = { scope, epoch: live.current.epoch + 1 };
  const [state, setState] = useState<{ scope: string; epoch: number; error?: string; reports?: ScoutReportDTO[]; balance?: string; slot?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setState(null); setBusy(false); }, [scope]);
  useEffect(() => () => { live.current.epoch++; }, []);
  const visible = state?.scope === scope && state.epoch === live.current.epoch ? state : null;
  async function load() {
    if (!pk || !s.userId) return;
    const started = scope;
    const epoch = live.current.epoch;
    setBusy(true); setState(null);
    try {
      const r = await list({ data: { agentId: id, wallet: pk } });
      if (live.current.scope !== started || live.current.epoch !== epoch) return;
      if (r.ok && r.wallet !== pk) throw new Error("Proven wallet changed; prove this connected wallet again.");
      setState(r.ok ? { scope: started, epoch, reports: r.reports, balance: r.balanceRaw, slot: r.slot } : { scope: started, epoch, error: r.error, balance: "balanceRaw" in r ? r.balanceRaw : undefined });
    } catch (e) {
      if (live.current.scope === started && live.current.epoch === epoch) setState({ scope: started, epoch, error: e instanceof Error ? e.message : "Report service unavailable" });
    } finally { if (live.current.scope === started && live.current.epoch === epoch) setBusy(false); }
  }
  return (
    <Panel>
      <p className="station-code text-amber">Holder-only reports</p>
      <p className="mt-1 text-sm text-cream/75">Prove your connected holder wallet, then request a fresh confirmed balance check. Access proofs last five minutes. Protected contents stay on the server until access is granted.</p>
      {!s.ready ? <Spinner /> : !s.userId ? <div className="mt-3"><AccountPanel purpose="request holder access" /></div> : (
        <div className="mt-3 flex flex-col gap-3">
          <WalletButton />
          <WalletProof key={scope} agentId={id} purpose="viewer" onVerified={() => void load()} />
          <Btn variant="line" disabled={busy || !pk} onClick={() => void load()}>{busy ? "Checking balance…" : "Check access with proven wallet"}</Btn>
          {!pk && <p className="text-xs text-cream/70">Connect a holder wallet to check access.</p>}
          {visible?.error && <Notice tone="error" title="Access not granted">{visible.error}{visible.balance ? ` (balance ${visible.balance} raw)` : ""}</Notice>}
          {visible?.reports && <Notice title={`Access granted · balance ${visible.balance} raw at slot ${visible.slot}`} />}
          {visible?.reports?.map(r => <ScoutReportView key={r.id} r={r} />)}
        </div>
      )}
    </Panel>
  );
}

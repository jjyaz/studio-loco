import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Btn, Cap, Notice, PageHead, Panel, Stat } from "@/components/kit";
import { fetchJson, METEORA_API, type PoolPage } from "@/lib/meteora-api";
import { DLMM_PROGRAM_ID } from "@/lib/dlmm";
import { explorerAccount, timeAgo } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { CAPABILITIES } from "@/lib/capabilities";

export const Route = createFileRoute("/network")({
  head: () => ({
    meta: [
      { title: "Network status — Studio Loco" },
      { name: "description", content: "Live Solana cluster and Meteora DLMM observatory: RPC slot, block height, program identity and API health." },
      { property: "og:title", content: "Network status — Studio Loco" },
      { property: "og:description", content: "Real cluster connectivity and DLMM program checks." },
    ],
  }),
  component: Network,
});

function Network() {
  const { connection } = useConnection();
  const { settings } = useSettings();
  const rpc = useQuery({
    queryKey: ["net-rpc", connection.rpcEndpoint],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const { PublicKey } = await import("@solana/web3.js");
      const t0 = performance.now();
      const slot = await connection.getSlot("confirmed");
      const latency = Math.round(performance.now() - t0);
      const [height, version, epoch, program] = await Promise.all([
        connection.getBlockHeight("confirmed"),
        connection.getVersion(),
        connection.getEpochInfo("confirmed"),
        connection.getAccountInfo(new PublicKey(DLMM_PROGRAM_ID)),
      ]);
      return { slot, latency, height, version: version["solana-core"], features: version["feature-set"], epoch: epoch.epoch, progress: epoch.slotIndex / epoch.slotsInEpoch, program: program ? { executable: program.executable, owner: program.owner.toBase58() } : null };
    },
  });
  const api = useQuery({
    queryKey: ["net-api"],
    enabled: settings.cluster === "mainnet-beta",
    refetchInterval: 30_000,
    retry: false,
    queryFn: async ({ signal }) => { const t0 = performance.now(); const p = await fetchJson<PoolPage>(`${METEORA_API}/pools?page=1&page_size=1`, { signal, retries: 0 }); return { total: p.total, latency: Math.round(performance.now() - t0) }; },
  });
  const counts = CAPABILITIES.reduce<Record<string, number>>((a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }), {});

  return (
    <SiteLayout>
      <PageHead code="SIG · Observatory" title="Signal box status." intro={`Real readings from ${connection.rpcEndpoint.replace(/\/\/([^/]+).*/, "//$1")} on ${settings.cluster}. Refreshes every 15s.`} cap={["live"]}>
        <Btn variant="line" size="sm" onClick={() => { rpc.refetch(); api.refetch(); }}>Refresh now</Btn>
      </PageHead>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <div className="flex justify-between"><h2 className="station-code text-amber">Solana RPC</h2><span className="station-code text-cream/60">{rpc.dataUpdatedAt ? timeAgo(rpc.dataUpdatedAt) : "—"}</span></div>
          {rpc.isError ? <div className="mt-3"><Notice tone="error" title="RPC unreachable">{redactUrls(String(((rpc.error) as Error)?.message ?? ""))}</Notice></div> : (
            <div className="mt-4 grid grid-cols-2 gap-5">
              <Stat label="Confirmed slot" value={rpc.data?.slot.toLocaleString() ?? "…"} />
              <Stat label="Block height" value={rpc.data?.height.toLocaleString() ?? "…"} />
              <Stat label="Latency" value={rpc.data ? `${rpc.data.latency} ms` : "…"} />
              <Stat label="Epoch" value={rpc.data ? `${rpc.data.epoch} · ${(rpc.data.progress * 100).toFixed(1)}%` : "…"} />
              <Stat label="Core version" value={rpc.data?.version ?? "…"} />
              <Stat label="Feature set" value={rpc.data?.features ?? "…"} />
            </div>
          )}
        </Panel>
        <Panel>
          <h2 className="station-code text-amber">Meteora DLMM program</h2>
          <p className="mt-3 break-all font-mono text-sm"><a className="underline" href={explorerAccount(DLMM_PROGRAM_ID, settings.cluster)} target="_blank" rel="noreferrer">{DLMM_PROGRAM_ID}</a></p>
          <div className="mt-4 grid grid-cols-2 gap-5">
            <Stat label="Account found" value={rpc.data ? (rpc.data.program ? "Yes" : "No") : "…"} />
            <Stat label="Executable" value={rpc.data?.program ? (rpc.data.program.executable ? "Yes" : "No") : "—"} />
            <Stat label="Loader" value={rpc.data?.program ? `${rpc.data.program.owner.slice(0, 10)}…` : "—"} />
            <Stat label="Data API" value={settings.cluster !== "mainnet-beta" ? "Mainnet only" : api.isError ? "Error" : api.data ? `OK · ${api.data.latency} ms` : "…"} sub={api.data ? `${api.data.total.toLocaleString()} pools indexed` : api.isError ? (api.error as Error).message : undefined} />
          </div>
        </Panel>
        <Panel tone="cobalt">
          <h2 className="station-code text-amber">Ciphernode network</h2>
          <p className="mt-3 text-cream/85">There is no Studio Loco operator network. A confidential-compute network with bonded operators is a separate future protocol integration. No node counts, stake or slashing figures are shown because none exist.</p>
          <Cap kind="not-deployed" className="mt-3" />
        </Panel>
        <Panel>
          <h2 className="station-code text-amber">Capability registry</h2>
          <p className="mt-2 text-sm text-cream/80">{counts["live"] ?? 0} live · {counts["simulation"] ?? 0} simulation · {counts["handoff"] ?? 0} handoff · {counts["not-deployed"] ?? 0} not deployed</p>
          <ul className="mt-3 max-h-64 overflow-auto text-sm">
            {CAPABILITIES.map((c) => <li key={c.id} className="flex justify-between gap-3 border-b border-line/50 py-2"><span>{c.area} · {c.name}</span><span className="station-code text-cream/70">{c.status}</span></li>)}
          </ul>
        </Panel>
      </div>
    </SiteLayout>
  );
}

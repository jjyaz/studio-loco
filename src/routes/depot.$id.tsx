import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Notice, Panel, Spinner } from "@/components/kit";
import { Addr, ScoutReportView } from "@/components/depot/shared";
import { getPublicPassport, listPublicReports } from "@/lib/depot.functions";
import { GatedReports } from "@/components/depot/GatedReports";
import night from "@/assets/studio-loco-night-station.png.asset.json";

export const Route = createFileRoute("/depot/$id")({
  loader: async ({ params }) => {
    const r = await getPublicPassport({ data: { id: params.id } }).catch(() => null);
    return { passport: r?.ok ? r.passport : null };
  },
  head: ({ loaderData }) => {
    const p = loaderData?.passport;
    const title = p ? `${p.name} — Depot passport · Studio Loco` : "Depot passport — Studio Loco";
    const desc = p ? `Scout agent passport with a signature-proven owner wallet${p.launch ? " and a verified DBC token launch" : ""}.` : "A Studio Loco Depot agent passport.";
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:type", content: "profile" },
        { name: "twitter:card", content: "summary" },
        ...(p ? [] : [{ name: "robots", content: "noindex" }]),
      ],
    };
  },
  component: PassportPage,
});

function PassportPage() {
  const { passport: p } = Route.useLoaderData();
  return (
    <SiteLayout>
      <div className="flex flex-col gap-6 py-6">
        <div className="relative overflow-hidden border border-line">
          <img src={night.url} alt="A midnight train at a lit night station" className="h-40 w-full object-cover md:h-56" />
          <div className="absolute inset-0 bg-gradient-to-t from-midnight to-transparent" aria-hidden />
          <div className="absolute bottom-4 left-4">
            <p className="station-code text-amber">Depot passport</p>
            <h1 className="display text-4xl md:text-6xl">{p?.name ?? "Not published"}</h1>
          </div>
        </div>
        {!p ? (
          <Notice title="No published passport here">This agent is private, unpublished or does not exist. <Link to="/app/depot" className="underline">Open the Depot</Link>.</Notice>
        ) : (
          <>
            <Panel>
              <p className="station-code text-amber">Scout · rev {p.revision}</p>
              <p className="mt-2 max-w-3xl text-cream/85">{p.description || "No mission description."}</p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="station-code text-cream/60">Owner wallet (signature-proven)</dt><dd><Addr a={p.wallet} label="owner wallet" /></dd></div>
                <div><dt className="station-code text-cream/60">Proven / published</dt><dd className="font-mono text-xs">{new Date(p.walletVerifiedAt).toISOString().slice(0, 10)} / {new Date(p.publishedAt).toISOString().slice(0, 10)}</dd></div>
                <div><dt className="station-code text-cream/60">Report access</dt><dd>{p.reportPolicy === "public" ? "Public" : <>Holders of <Addr a={p.gateMint} label="gate mint" /> ≥ <span className="font-mono">{p.gateMinRaw}</span> raw</>}</dd></div>
                <div><dt className="station-code text-cream/60">Capabilities</dt><dd className="text-xs text-cream/75">Read-only market reports. No autonomous signing, custody, staking or payments.</dd></div>
              </dl>
            </Panel>
            <Panel>
              <p className="station-code text-amber">Token</p>
              {p.launch ? (
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="station-code text-cream/60">Mint</dt><dd><Addr a={p.launch.mint} label="mint" /></dd></div>
                  <div><dt className="station-code text-cream/60">DBC pool</dt><dd><Addr a={p.launch.pool} label="pool" /></dd></div>
                  <div><dt className="station-code text-cream/60">Launch receipt</dt><dd><a className="font-mono underline" href={`https://solscan.io/tx/${p.launch.signature}`} target="_blank" rel="noreferrer">{p.launch.signature.slice(0, 16)}…</a> · slot {p.launch.slot}</dd></div>
                  <div><dt className="station-code text-cream/60">Preset · metadata</dt><dd className="font-mono text-xs">{p.launch.presetId}@{p.launch.presetVersion} · {p.launch.metadataDigest.slice(0, 16)}…</dd></div>
                  <p className="text-xs text-cream/60 sm:col-span-2">Verified by Studio Loco's server against the exact confirmed message at link time. Reserves, fees and graduation status change; read them fresh onchain.</p>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-cream/75">No verified token launch is linked to this agent.</p>
              )}
            </Panel>
            {p.reportPolicy === "public" ? <PublicReports id={p.id} /> : <GatedReports key={`${p.id}:${p.revision}`} id={p.id} />}
          </>
        )}
      </div>
    </SiteLayout>
  );
}

function PublicReports({ id }: { id: string }) {
  const list = useServerFn(listPublicReports);
  const q = useQuery({ queryKey: ["depot", "public-reports", id], queryFn: () => list({ data: { agentId: id } }) });
  return (
    <Panel>
      <p className="station-code text-amber">Scout reports</p>
      {q.isLoading && <Spinner label="Loading reports" />}
      {q.isError && <Notice tone="error" title="Reports unavailable">The report service could not be reached. <button className="underline" onClick={() => void q.refetch()}>Try again</button>.</Notice>}
      {q.data && !q.data.ok && <Notice tone="error" title="Reports unavailable">{q.data.error}</Notice>}
      {q.data?.ok && q.data.reports.length === 0 && <p className="mt-2 text-sm text-cream/70">No reports yet.</p>}
      <div className="mt-3 flex flex-col gap-3">{q.data?.ok && q.data.reports.map((r) => <ScoutReportView key={r.id} r={r} />)}</div>
    </Panel>
  );
}

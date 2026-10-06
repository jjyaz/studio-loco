import { createFileRoute } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Btn, Cap, PageHead, Panel } from "@/components/kit";
import { useLocalState } from "@/lib/settings";

export const Route = createFileRoute("/token")({
  head: () => ({
    meta: [
      { title: "LOCO planning worksheet — Studio Loco" },
      { name: "description", content: "A local planning worksheet for exploring hypothetical allocations, not an official distribution or commitment." },
      { property: "og:title", content: "LOCO planning worksheet — Studio Loco" },
      { property: "og:description", content: "Explore hypothetical allocations in a clearly labelled local planning worksheet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Token,
});

interface Row { label: string; pct: number }
const DEFAULT: Row[] = [{ label: "Community", pct: 40 }, { label: "Contributors", pct: 25 }, { label: "Treasury", pct: 25 }, { label: "Liquidity", pct: 10 }];

function Token() {
  const [rows, setRows] = useLocalState<Row[]>("studio-loco:token-worksheet:v1", DEFAULT);
  const total = rows.reduce((a, r) => a + (Number.isFinite(r.pct) ? r.pct : 0), 0);
  return (
    <SiteLayout>
      <PageHead code="LOCO · Worksheet" title="LOCO planning worksheet." intro="Explore hypothetical allocations. This worksheet is not an official distribution or commitment." cap={["simulation"]} />
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="display text-2xl">Planning worksheet</h2><span className="station-code border border-amber px-2 py-1 text-amber">Proposal · not a commitment</span></div>
        <p className="mt-2 text-sm text-cream/75">A private scratchpad stored in your browser for thinking through a hypothetical distribution. It does not represent any plan by Studio Loco.</p>
        <table className="mt-4 w-full text-sm">
          <thead><tr className="text-left station-code text-cream/70"><th className="py-2">Bucket</th><th className="py-2 text-right">%</th><th className="py-2"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line/50">
                <td className="py-2"><input aria-label={`Bucket ${i + 1} name`} value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value.slice(0, 40) } : x)))} className="min-h-10 w-full bg-transparent px-2 outline-none focus:bg-muted" /></td>
                <td className="py-2 text-right"><input aria-label={`Bucket ${i + 1} percent`} type="number" min={0} max={100} value={r.pct} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: Number(e.target.value) } : x)))} className="min-h-10 w-24 bg-transparent px-2 text-right font-mono outline-none focus:bg-muted" /></td>
                <td className="py-2 text-right"><Btn size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Btn size="sm" variant="line" onClick={() => setRows([...rows, { label: "New bucket", pct: 0 }])}>Add bucket</Btn>
          <span className={`font-mono ${Math.abs(total - 100) < 1e-9 ? "text-success" : "text-destructive"}`}>Total {total}% {Math.abs(total - 100) < 1e-9 ? "" : "(must equal 100%)"}</span>
        </div>
        <Cap kind="simulation" className="mt-4" />
      </Panel>
    </SiteLayout>
  );
}

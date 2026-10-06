import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Field, PageHead } from "@/components/kit";
import { DOCS } from "@/content/docs";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — Studio Loco" },
      { name: "description", content: "Guides to wallets, DLMM bins, fees and strategies, swaps, range risk, signals, pool launches and the privacy distinction." },
      { property: "og:title", content: "Studio Loco Docs" },
      { property: "og:description", content: "Searchable, original guides for Meteora DLMM on Studio Loco." },
    ],
  }),
  component: Docs,
});

function Docs() {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? DOCS.filter((d) => (d.title + d.body.join(" ")).toLowerCase().includes(t)) : DOCS;
  }, [q]);
  const groups = [...new Set(DOCS.map((d) => d.group))];
  return (
    <SiteLayout>
      <PageHead code="DOC · Timetable" title="How the line works." />
      <div className="grid gap-10 lg:grid-cols-[260px_1fr]">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Field label="Search docs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="slippage, bins…" />
          <nav aria-label="Docs" className="mt-6 flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g}>
                <p className="station-code text-amber">{g}</p>
                <ul className="mt-2 flex flex-col gap-1">{DOCS.filter((d) => d.group === g).map((d) => <li key={d.id}><a href={`#${d.id}`} className="block min-h-9 py-1 text-sm text-cream/85 hover:text-amber">{d.title}</a></li>)}</ul>
              </div>
            ))}
          </nav>
        </aside>
        <div className="flex flex-col gap-12">
          {list.length === 0 && <p className="text-cream/70">No guides match “{q}”.</p>}
          {list.map((d) => (
            <article key={d.id} id={d.id} className="scroll-mt-6 border-t border-line pt-6">
              <p className="station-code text-cream/60">{d.group}</p>
              <h2 className="display mt-2 text-3xl"><a href={`#${d.id}`} className="hover:text-amber">{d.title}</a></h2>
              {d.body.map((p, i) => <p key={i} className="mt-4 max-w-3xl text-cream/85">{p}</p>)}
              {d.links && <ul className="mt-4 flex flex-wrap gap-3">{d.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer" className="station-code text-amber underline">{l.label} ↗</a></li>)}</ul>}
            </article>
          ))}
        </div>
      </div>
    </SiteLayout>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteChrome";
import { PageHead } from "@/components/kit";
import { NOTES } from "@/content/journal";

export const Route = createFileRoute("/journal/")({
  head: () => ({
    meta: [
      { title: "Field Notes — Studio Loco" },
      { name: "description", content: "Original educational notes on DLMM bins, strategies and the limits of browser privacy." },
      { property: "og:title", content: "Field Notes — Studio Loco" },
      { property: "og:description", content: "Dated, sourced notes from the Studio Loco line." },
    ],
  }),
  component: () => (
    <SiteLayout>
      <PageHead code="FN · Field Notes" title="Notes from the line." />
      <ol className="flex flex-col divide-y divide-line border-y border-line">
        {NOTES.map((n) => (
          <li key={n.slug}>
            <Link to="/journal/$slug" params={{ slug: n.slug }} className="group grid gap-2 py-8 md:grid-cols-[180px_1fr]">
              <span className="station-code text-amber">{n.code} · {n.date}</span>
              <span><span className="display block text-3xl group-hover:text-amber">{n.title}</span><span className="mt-2 block text-cream/75">{n.summary}</span></span>
            </Link>
          </li>
        ))}
      </ol>
    </SiteLayout>
  ),
});

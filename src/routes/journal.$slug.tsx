import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Eyebrow, btn } from "@/components/kit";
import { getNote } from "@/content/journal";

export const Route = createFileRoute("/journal/$slug")({
  loader: async ({ params }) => {
    const note = getNote(params.slug);
    if (!note) throw notFound();
    return { note };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Not found — Studio Loco" }, { name: "robots", content: "noindex" }] };
    const n = loaderData.note;
    return { meta: [{ title: `${n.title} — Studio Loco` }, { name: "description", content: n.summary }, { property: "og:title", content: n.title }, { property: "og:description", content: n.summary }, { property: "og:type", content: "article" }] };
  },
  notFoundComponent: NoteNotFound,
  errorComponent: ({ error }) => <SiteLayout><p role="alert">{error instanceof Error ? error.message : "Error"}</p></SiteLayout>,
  component: NotePage,
});

function NoteNotFound() {
  return <SiteLayout><h1 className="display text-4xl">No such field note.</h1><Link to="/journal" className={btn({ variant: "line" }) + " mt-6"}>All notes</Link></SiteLayout>;
}

function NotePage() {
  const { note } = Route.useLoaderData();
  return (
    <SiteLayout>
      <article className="mx-auto max-w-3xl">
        <Eyebrow>{note.code} · <time dateTime={note.date}>{note.date}</time></Eyebrow>
        <h1 className="display mt-4 text-4xl md:text-6xl">{note.title}</h1>
        <p className="mt-5 text-lg text-cream/85">{note.summary}</p>
        {note.sections.map((s) => (
          <section key={s.heading} id={s.heading.toLowerCase().replace(/\W+/g, "-")} className="mt-10">
            <h2 className="text-2xl font-semibold">{s.heading}</h2>
            {s.body.map((p, i) => <p key={i} className="mt-4 leading-relaxed text-cream/85">{p}</p>)}
          </section>
        ))}
        <aside className="mt-12 border-t border-line pt-6">
          <p className="station-code text-amber">Sources</p>
          <ul className="mt-3 flex flex-col gap-2">{note.sources.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer" className="underline">{s.label} ↗</a></li>)}</ul>
        </aside>
        <Link to="/journal" className={btn({ variant: "line" }) + " mt-10"}>← All field notes</Link>
      </article>
    </SiteLayout>
  );
}

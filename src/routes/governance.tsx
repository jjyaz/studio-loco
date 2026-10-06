import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Btn, Cap, Field, PageHead, Panel } from "@/components/kit";
import { useLocalState } from "@/lib/settings";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/governance")({
  head: () => ({
    meta: [
      { title: "Decision Room — Studio Loco" },
      { name: "description", content: "A local decision-room demo for drafting proposals and walking their lifecycle. No DAO exists; nothing here is binding." },
      { property: "og:title", content: "Decision Room — Studio Loco" },
      { property: "og:description", content: "Local proposal lifecycle demo. Not a live DAO." },
    ],
  }),
  component: Gov,
});

type Stage = "draft" | "discussion" | "voting" | "closed";
interface Proposal { id: string; title: string; body: string; stage: Stage; yes: number; no: number; abstain: number }
const STAGES: Stage[] = ["draft", "discussion", "voting", "closed"];

function Gov() {
  const [props, setProps] = useLocalState<Proposal[]>("studio-loco:proposals:v1", []);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const upd = (id: string, f: (p: Proposal) => Proposal) => setProps((ps) => ps.map((p) => (p.id === id ? f(p) : p)));
  return (
    <SiteLayout>
      <PageHead code="GOV · Decision Room" title="A room to practise deciding." intro="Draft proposals and move them through a lifecycle on your own device. There is no Studio Loco DAO, token vote or onchain governance." cap={["simulation"]}>
        <Link to="/lab" search={{ mode: "ballot" }} className="underline">Try a secret-ballot simulation →</Link>
      </PageHead>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
        <Panel>
          <h2 className="station-code text-amber">New proposal (local)</h2>
          <Field className="mt-3" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          <label htmlFor="pbody" className="station-code mt-3 block text-cream/80">Summary</label>
          <textarea id="pbody" value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} rows={5} className="mt-1 w-full border border-input bg-midnight p-3 text-sm" />
          <Btn className="mt-3" disabled={!title.trim()} onClick={() => { setProps((ps) => [{ id: crypto.randomUUID(), title: title.trim(), body: body.trim(), stage: "draft", yes: 0, no: 0, abstain: 0 }, ...ps]); setTitle(""); setBody(""); }}>Add draft</Btn>
        </Panel>
        <div className="flex flex-col gap-4">
          {props.length === 0 && <p className="text-cream/70">No proposals yet.</p>}
          {props.map((p) => (
            <Panel key={p.id}>
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-semibold">{p.title}</h3><Cap kind="simulation" /></div>
              {p.body && <p className="mt-2 text-sm text-cream/80">{p.body}</p>}
              <ol className="mt-3 flex flex-wrap gap-1">{STAGES.map((s) => <li key={s} className={cn("station-code border px-2 py-1", p.stage === s ? "border-amber text-amber" : "border-line text-cream/50")}>{s}</li>)}</ol>
              {p.stage === "voting" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["yes", "no", "abstain"] as const).map((k) => <Btn key={k} size="sm" variant="quiet" onClick={() => upd(p.id, (x) => ({ ...x, [k]: x[k] + 1 }))}>{k} ({p[k]})</Btn>)}
                </div>
              )}
              {p.stage === "closed" && <p className="mt-3 font-mono text-sm">Result: yes {p.yes} · no {p.no} · abstain {p.abstain} → {p.yes > p.no ? "passes (locally)" : "does not pass"}</p>}
              <div className="mt-3 flex gap-2">
                {p.stage !== "closed" && <Btn size="sm" variant="line" onClick={() => upd(p.id, (x) => ({ ...x, stage: STAGES[STAGES.indexOf(x.stage) + 1] ?? x.stage }))}>Advance to {STAGES[STAGES.indexOf(p.stage) + 1]}</Btn>}
                <Btn size="sm" variant="danger" onClick={() => setProps((ps) => ps.filter((x) => x.id !== p.id))}>Delete</Btn>
              </div>
            </Panel>
          ))}
        </div>
      </div>
    </SiteLayout>
  );
}

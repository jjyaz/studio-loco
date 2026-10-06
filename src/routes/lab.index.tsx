import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { SiteLayout } from "@/components/site/SiteChrome";
import { Btn, Cap, Field, Notice, PageHead, Panel, Segmented } from "@/components/kit";
import { newKey, open, seal, tallyBallot, tallyHistogram, tallySealedBid, type LabMode, type Phase, type Sealed } from "@/lib/lab";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lab/")({
  validateSearch: zodValidator(z.object({ mode: z.enum(["ballot", "sealed-bid", "histogram"]).optional().catch(undefined) })),
  head: () => ({
    meta: [
      { title: "Coordination Lab — Studio Loco" },
      { name: "description", content: "Local educational simulations of secret ballots, sealed-bid aggregates and shared histograms using Web Crypto. Not a deployed confidential protocol." },
      { property: "og:title", content: "Coordination Lab — Studio Loco" },
      { property: "og:description", content: "Learn the confidential-coordination lifecycle with honest local simulations." },
    ],
  }),
  component: Lab,
});

const PHASES: { id: Phase; label: string }[] = [
  { id: "setup", label: "Request" },
  { id: "open", label: "Input window" },
  { id: "closed", label: "Window closed" },
  { id: "tallied", label: "Aggregate published" },
];

const BANNER = "Local educational simulation — not a deployed confidential protocol";

function Lab() {
  const s = Route.useSearch();
  const [mode, setMode] = useState<LabMode>(s.mode ?? "ballot");
  return (
    <SiteLayout>
      <PageHead code="LAB · Coordination" title="Private coordination, explained honestly." intro="Run a full input-window lifecycle in your browser. Contributions are encrypted and committed locally, then aggregated. See exactly which guarantees this does — and does not — give." cap={["simulation"]}>
        <Link to="/lab/architecture" className="underline">What a real Solana deployment needs →</Link>
      </PageHead>
      <div className="mb-6 border-2 border-amber bg-midnight p-4 text-center station-code text-amber" role="note">{BANNER}</div>
      <Segmented<LabMode> label="Experiment" value={mode} onChange={setMode} options={[{ value: "ballot", label: "Secret ballot" }, { value: "sealed-bid", label: "Sealed-bid aggregate" }, { value: "histogram", label: "Shared histogram" }]} />
      <Experiment key={mode} mode={mode} />
    </SiteLayout>
  );
}

function Experiment({ mode }: { mode: LabMode }) {
  const keyRef = useRef<CryptoKey | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");
  const [options, setOptions] = useState("Local line, Express line, Switchback");
  const [edges, setEdges] = useState("10, 50, 100");
  const [window, setWindowSecs] = useState("120");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sealed, setSealed] = useState<Sealed[]>([]);
  const [label, setLabel] = useState("Participant 1");
  const [value, setValue] = useState("");
  const [result, setResult] = useState<null | { verified: number; failed: number; text: string[] }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cryptoOk, setCryptoOk] = useState(true);

  useEffect(() => { setCryptoOk(typeof crypto !== "undefined" && !!crypto.subtle); }, []);
  useEffect(() => {
    if (phase !== "open") return;
    const t = setInterval(() => { setNow(Date.now()); }, 500);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => { if (phase === "open" && deadline && now >= deadline) setPhase("closed"); }, [now, deadline, phase]);

  const opts = options.split(",").map((o) => o.trim()).filter(Boolean);
  const edgeNums = edges.split(",").map((e) => Number(e.trim())).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  async function start() {
    setErr(null);
    const secs = Number(window);
    if (!(secs >= 10 && secs <= 3600)) return setErr("Window must be 10–3600 seconds");
    if (mode === "ballot" && opts.length < 2) return setErr("Add at least two options");
    if (mode === "histogram" && edgeNums.length < 1) return setErr("Add at least one bucket edge");
    keyRef.current = await newKey();
    setSealed([]); setResult(null);
    setDeadline(Date.now() + secs * 1000); setNow(Date.now());
    setPhase("open");
    if (mode === "ballot") setValue(opts[0] ?? "");
  }

  async function submit() {
    setErr(null);
    if (!keyRef.current) return;
    if (mode !== "ballot" && !(Number(value) >= 0)) return setErr("Enter a non-negative number");
    if (!label.trim()) return setErr("Label your contribution");
    const s = await seal(keyRef.current, label.trim().slice(0, 40), value);
    setSealed((x) => [...x, s]);
    setLabel(`Participant ${sealed.length + 2}`);
    if (mode !== "ballot") setValue("");
  }

  async function tally() {
    if (!keyRef.current) return;
    const opened = await Promise.all(sealed.map((s) => open(keyRef.current!, s).catch(() => ({ value: "", verified: false }))));
    const good = opened.filter((o) => o.verified).map((o) => o.value);
    const failed = opened.length - good.length;
    let text: string[] = [];
    if (mode === "ballot") {
      const t = tallyBallot(good, opts);
      text = [...Object.entries(t.counts).map(([k, v]) => `${k}: ${v}`), ...(t.invalid ? [`Invalid: ${t.invalid}`] : [])];
    } else if (mode === "sealed-bid") {
      const t = tallySealedBid(good);
      text = t ? [`Winning contribution: #${t.winner + 1} (${sealed[t.winner]?.label})`, `Clearing price (second-highest): ${t.clearing}`, `Valid bids: ${t.count}`] : ["No valid bids"];
    } else {
      const b = tallyHistogram(good, edgeNums);
      text = b.map((n, i) => `${i === 0 ? `< ${edgeNums[0]}` : i === edgeNums.length ? `≥ ${edgeNums[i - 1]}` : `${edgeNums[i - 1]}–${edgeNums[i]}`}: ${n}`);
    }
    keyRef.current = null; // key discarded after publication
    setResult({ verified: good.length, failed, text });
    setPhase("tallied");
  }

  const remaining = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;

  if (!cryptoOk) return <Notice tone="error" title="Web Crypto unavailable">This browser context lacks SubtleCrypto (it requires HTTPS). The lab can't run here.</Notice>;

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Panel>
        <ol className="mb-6 flex flex-wrap gap-2" aria-label="Lifecycle">
          {PHASES.map((p, i) => (
            <li key={p.id} className={cn("station-code border px-2 py-1", phase === p.id ? "border-amber bg-amber text-midnight" : PHASES.findIndex((x) => x.id === phase) > i ? "border-cream/40 text-cream/70" : "border-line text-cream/50")}>{i + 1}. {p.label}</li>
          ))}
        </ol>
        {phase === "setup" && (
          <div className="flex flex-col gap-3">
            {mode === "ballot" && <Field label="Ballot options (comma separated)" value={options} onChange={(e) => setOptions(e.target.value)} />}
            {mode === "histogram" && <Field label="Bucket edges (comma separated)" value={edges} onChange={(e) => setEdges(e.target.value)} />}
            {mode === "sealed-bid" && <p className="text-sm text-cream/80">Participants submit sealed bids. Only the winner and second-highest clearing price are published.</p>}
            <Field label="Input window (seconds)" inputMode="numeric" value={window} onChange={(e) => setWindowSecs(e.target.value)} />
            <Btn onClick={start}>Open input window</Btn>
          </div>
        )}
        {phase === "open" && (
          <div className="flex flex-col gap-3">
            <p className="station-code text-amber">Window closes in {remaining}s</p>
            <Field label="Contributor label" value={label} onChange={(e) => setLabel(e.target.value)} />
            {mode === "ballot" ? (
              <fieldset><legend className="station-code mb-2 text-cream/80">Choice</legend>
                <div className="flex flex-col gap-1">{opts.map((o) => <label key={o} className="flex min-h-10 items-center gap-2"><input type="radio" name="choice" checked={value === o} onChange={() => setValue(o)} className="accent-[var(--amber)]" />{o}</label>)}</div>
              </fieldset>
            ) : <Field label={mode === "sealed-bid" ? "Bid" : "Value"} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
            <Btn onClick={submit}>Encrypt & submit</Btn>
            <Btn variant="line" onClick={() => setPhase("closed")}>Close window early</Btn>
          </div>
        )}
        {phase === "closed" && (
          <div className="flex flex-col gap-3">
            <p className="text-cream/80">{sealed.length} sealed contribution(s). No further inputs accepted.</p>
            <Btn onClick={tally} disabled={!sealed.length}>Decrypt aggregate & verify commitments</Btn>
          </div>
        )}
        {phase === "tallied" && result && (
          <div className="flex flex-col gap-3">
            <h3 className="display text-2xl">Aggregate</h3>
            <ul className="font-mono text-sm">{result.text.map((t) => <li key={t}>{t}</li>)}</ul>
            <p className={cn("station-code", result.failed ? "text-destructive" : "text-success")}>Commitment check: {result.verified} matched · {result.failed} failed</p>
            <p className="text-xs text-cream/70">This is a hash re-check performed by the same browser that held the key — not a zero-knowledge proof and not independently verifiable.</p>
            <Btn variant="line" onClick={() => setPhase("setup")}>Run again</Btn>
          </div>
        )}
        {err && <p role="alert" className="mt-3 text-sm text-destructive">{err}</p>}
      </Panel>
      <div className="flex flex-col gap-6">
        <Panel tone="cobalt">
          <h3 className="station-code text-amber">Sealed inputs ({sealed.length})</h3>
          {sealed.length === 0 ? <p className="mt-2 text-sm text-cream/70">Nothing submitted yet.</p> : (
            <ul className="mt-3 flex max-h-72 flex-col gap-2 overflow-auto">
              {sealed.map((s) => <li key={s.id} className="border-l-2 border-amber pl-3 text-xs"><span className="text-cream">{s.label}</span><span className="block break-all font-mono text-cream/60">ct {s.ciphertext.slice(0, 32)}…</span><span className="block break-all font-mono text-cream/60">sha256 {s.commitment.slice(0, 32)}…</span></li>)}
            </ul>
          )}
        </Panel>
        <Panel>
          <h3 className="station-code text-amber">What this shows vs. a real protocol</h3>
          <table className="mt-3 w-full text-sm">
            <tbody className="[&_td]:border-b [&_td]:border-line/50 [&_td]:py-2">
              <tr><td>Lifecycle: request → window → aggregate</td><td className="text-success">Modelled</td></tr>
              <tr><td>Inputs encrypted at rest (AES-GCM)</td><td className="text-success">Yes, locally</td></tr>
              <tr><td>Input commitments (SHA-256)</td><td className="text-success">Yes, re-checked</td></tr>
              <tr><td>No single party can decrypt</td><td className="text-destructive">No — one key</td></tr>
              <tr><td>Random committee + DKG</td><td className="text-destructive">No</td></tr>
              <tr><td>Computation over ciphertexts (FHE)</td><td className="text-destructive">No</td></tr>
              <tr><td>Proof of correct computation (ZK)</td><td className="text-destructive">No</td></tr>
              <tr><td>Authenticated, sybil-resistant inputs</td><td className="text-destructive">No</td></tr>
            </tbody>
          </table>
          <div className="mt-3"><Cap kind="simulation" /></div>
        </Panel>
      </div>
    </div>
  );
}

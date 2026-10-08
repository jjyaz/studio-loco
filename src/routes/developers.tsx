import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  Braces,
  Copy,
  Check,
  Radio,
  TrainFront,
  FileSearch,
  Terminal,
  ArrowUpRight,
} from "lucide-react";
import { SiteLayout } from "@/components/site/SiteChrome";
import { btn, Field } from "@/components/kit";
import {
  LocoClient,
  analyzeRecorderExport,
  planRange,
  LocoError,
} from "../../packages/sdk/src/index";
export const Route = createFileRoute("/developers")({
  head: () => ({
    meta: [
      { title: "Developer Station — Studio Loco" },
      {
        name: "description",
        content:
          "Build with Loco: a typed SDK, versioned read-only API, real MCP connection and local Flight Recorder analysis for Meteora DLMM.",
      },
    ],
  }),
  component: Developers,
});
const base = "https://studioloco.cfd/api/public/loco/v1";
const install = `npm install ${base}/sdk/0.1.0.tgz`;
const example = `import { LocoClient } from '@studio-loco/sdk';\n\nconst loco = new LocoClient();\nconst { data, meta } = await loco.listPools({ perPage: 5 });\n\nconsole.log(meta.source, data.pools);\n// meteora-index · real mainnet pools`;
function CopyCode({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="relative">
      <button
        type="button"
        className="station-code absolute right-3 top-3 flex min-h-9 items-center gap-2 rounded border border-line bg-midnight px-3 text-amber"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setError("");
          } catch {
            setError("Select the code to copy it.");
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : label}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-line bg-black/20 p-5 pt-16 text-sm leading-7 text-cream/90">
        <code>{text}</code>
      </pre>
      {error && (
        <p className="mt-2 text-sm text-amber" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
function Developers() {
  const [endpoint, setEndpoint] = useState("pools"),
    [pool, setPool] = useState(""),
    [position, setPosition] = useState("");
  const [response, setResponse] = useState<unknown>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [evidence, setEvidence] = useState<unknown>(null),
    [evidenceError, setEvidenceError] = useState("");
  const [active, setActive] = useState("12"),
    [lower, setLower] = useState("-10"),
    [upper, setUpper] = useState("9"),
    [geometry, setGeometry] = useState<unknown>(null),
    [rangeError, setRangeError] = useState("");
  const run = async () => {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setBusy(true);
    setError("");
    setResponse(null);
    try {
      const loco = new LocoClient({ baseUrl: `${window.location.origin}/api/public/loco/v1` });
      const r =
        endpoint === "capabilities"
          ? await loco.capabilities({ signal: c.signal })
          : endpoint === "pool"
            ? await loco.getPool(pool.trim(), { signal: c.signal })
            : endpoint === "position"
              ? await loco.getPosition(position.trim(), pool.trim(), { signal: c.signal })
              : await loco.listPools({ perPage: 3 }, { signal: c.signal });
      if (!c.signal.aborted) setResponse(r);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof LocoError ? `${e.code}: ${e.message}` : "Read failed. Retry shortly.",
        );
    } finally {
      if (request.current === c) setBusy(false);
    }
  };
  return (
    <SiteLayout>
      <section className="relative overflow-hidden rounded-xl border border-line bg-navy px-6 py-10 md:px-10 md:py-14">
        <div
          className="pointer-events-none absolute right-0 top-0 h-full w-1/2 opacity-10"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg,transparent,transparent 22px,#f0b35b 23px,transparent 24px)",
            transform: "skewX(-20deg)",
          }}
        />
        <div className="relative">
          <p className="station-code flex items-center gap-2 text-amber">
            <TrainFront size={17} /> DEV · Platform 01{" "}
            <span className="ml-3 rounded-full border border-amber/30 px-3 py-1 text-xs">
              SDK v0.1.0
            </span>
          </p>
          <h1 className="display mt-5 max-w-3xl text-5xl leading-tight md:text-7xl">
            Loco, beyond
            <br />
            <span className="text-amber">the terminal.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-cream/75">
            Connect your app. Give your agent a clear view. Build on real Meteora DLMM observations
            with a typed SDK, public API and read-only MCP.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="#quickstart" className={btn()}>
              Start building <ArrowUpRight size={16} />
            </a>
            <a
              href={`${base}/openapi.json`}
              className={btn({ variant: "line" })}
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI specification
            </a>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                icon: Braces,
                label: "01 · SDK",
                title: "Typed. Bounded. Portable.",
                detail: "Runtime-checked ESM client + local helpers.",
              },
              {
                icon: Radio,
                label: "02 · API v1",
                title: "Provenance with every read.",
                detail: "Index metrics or confirmed chain snapshots.",
              },
              {
                icon: Terminal,
                label: "03 · MCP",
                title: "Agents with a view.",
                detail: "Five hosted tools. No signing or write paths.",
              },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-line bg-midnight/70 p-5">
                <p className="station-code flex items-center gap-2 text-amber">
                  <c.icon size={16} />
                  {c.label}
                </p>
                <h2 className="mt-3 text-xl text-cream">{c.title}</h2>
                <p className="mt-2 text-sm text-cream/65">{c.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section id="quickstart" className="mt-14 grid gap-8 lg:grid-cols-2">
        <div>
          <p className="station-code text-amber">01 · Quick start</p>
          <h2 className="display mt-3 text-3xl">A small package. A real connection.</h2>
          <p className="mb-5 mt-4 text-cream/70">
            Install the versioned package directly. Node 20+ or a browser with fetch. This release
            is distributed from Loco, with TypeScript declarations and examples included.
          </p>
          <CopyCode text={install} />
          <p className="mt-3 text-xs text-cream/60">
            Downloadable npm package · ESM · v0.1.0 · not published to the npm registry.
          </p>
          <a
            className="mt-4 inline-block text-sm text-amber underline"
            href={`${base}/sdk/0.1.0.tgz`}
          >
            Download package ↓
          </a>
        </div>
        <div>
          <p className="mb-4 station-code text-cream/55">LIVE MAINNET · NO FIXTURE FALLBACK</p>
          <CopyCode text={example} />
          <p className="mt-4 text-sm text-cream/65">
            15-second deadline, cancellation, bounded responses and typed errors. Missing metrics
            stay null. No keys or wallet connection required.
          </p>
        </div>
      </section>
      <section className="mt-14 rounded-xl border border-line p-6 md:p-8" id="explorer">
        <p className="station-code text-amber">02 · Live API explorer</p>
        <h2 className="display mt-3 text-3xl">Read the line yourself.</h2>
        <p className="mt-3 text-cream/65">
          These buttons call the deployed API. Pool metrics come from Meteora’s index. Position
          bounds and the active bin share one confirmed chain snapshot; mints are validated at or
          after its slot.
        </p>
        <div className="mt-6 grid items-end gap-4 md:grid-cols-3">
          <label className="text-sm text-cream/75">
            Read
            <select
              aria-label="API read"
              className="mt-2 block min-h-11 w-full rounded border border-line bg-midnight px-3 text-cream"
              value={endpoint}
              onChange={(e) => {
                request.current?.abort();
                setBusy(false);
                setEndpoint(e.target.value);
                setResponse(null);
                setError("");
              }}
            >
              <option value="pools">List pools · 3 rows</option>
              <option value="capabilities">Capabilities</option>
              <option value="pool">Pool metadata</option>
              <option value="position">Verified position</option>
            </select>
          </label>
          {(endpoint === "pool" || endpoint === "position") && (
            <Field
              label="DLMM pool address"
              value={pool}
              onChange={(e) => setPool(e.target.value)}
              placeholder="32-byte base58 pool address"
            />
          )}
          {endpoint === "position" && (
            <Field
              label="PositionV2 address"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="Existing position address"
            />
          )}
          <button type="button" className={btn()} disabled={busy} onClick={run}>
            {busy ? "Reading live data…" : "Run read-only request"}
          </button>
        </div>
        <div aria-live="polite">
          {error && (
            <p role="alert" className="mt-5 text-amber">
              {error}
            </p>
          )}
          {response !== null ? (
            <pre className="mt-6 max-h-[480px] overflow-auto rounded-lg border border-line bg-black/20 p-5 text-xs leading-6 text-cream/85">
              <code>{JSON.stringify(response, null, 2)}</code>
            </pre>
          ) : (
            !busy && (
              <p className="mt-5 text-sm text-cream/50">
                Run a request to inspect the actual response and its source.
              </p>
            )
          )}
        </div>
      </section>
      <section className="mt-14 grid gap-8 lg:grid-cols-2" id="mcp">
        <div>
          <p className="station-code text-amber">03 · Connect an agent</p>
          <h2 className="display mt-3 text-3xl">Read-only, by construction.</h2>
          <p className="my-4 text-cream/70">
            Add this URL as a remote Streamable HTTP MCP connection. No authentication required. The
            same five tools are also available over local stdio.
          </p>
          <CopyCode text={`${base}/mcp`} />
          <div className="mt-5 flex flex-wrap gap-2">
            {[
              "Capabilities",
              "List pools",
              "Pool metadata",
              "Position snapshot",
              "Range geometry",
            ].map((t) => (
              <span key={t} className="rounded border border-line px-3 py-2 text-xs text-cream/70">
                {t}
              </span>
            ))}
          </div>
          <p className="mt-4 text-sm text-cream/65">
            Official MCP server v2.3.1 · modern 2026 protocol + stateless 2025 compatibility.
            Private cloud records, signing and execution are outside this connection.
          </p>
        </div>
        <div>
          <p className="mb-4 station-code text-cream/55">STDIO CONFIG · NODE 20+</p>
          <CopyCode
            text={JSON.stringify(
              {
                mcpServers: {
                  "studio-loco": {
                    command: "npx",
                    args: ["--yes", "--package", `${base}/sdk/0.1.0.tgz`, "loco-mcp"],
                  },
                },
              },
              null,
              2,
            )}
          />
        </div>
      </section>
      <section className="mt-14 grid gap-8 lg:grid-cols-2">
        <div className="rounded-xl border border-line p-6">
          <p className="station-code flex items-center gap-2 text-amber">
            <FileSearch size={16} />
            04 · Local evidence
          </p>
          <h2 className="display mt-3 text-2xl">Inspect a Recorder export.</h2>
          <p className="my-4 text-sm text-cream/70">
            Choose an explicitly exported Flight Recorder JSON. Analysis runs on your device and
            reports consistency counts. It does not upload the file or verify its claims on chain.
          </p>
          <label className="block text-sm text-cream/80">
            Recorder v1 JSON
            <input
              aria-label="Recorder v1 JSON"
              type="file"
              accept=".json,application/json"
              className="mt-3 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-amber file:px-4 file:py-3 file:text-midnight"
              onChange={async (e) => {
                setEvidence(null);
                setEvidenceError("");
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  if (f.size > 5_000_000) throw new Error("Choose an export under 5 MB.");
                  setEvidence(analyzeRecorderExport(JSON.parse(await f.text())));
                } catch {
                  setEvidenceError(
                    "Choose a valid Recorder v1 export under 5 MB with at most 2,000 records.",
                  );
                }
              }}
            />
          </label>
          {evidenceError && (
            <p role="alert" className="mt-4 text-sm text-amber">
              {evidenceError}
            </p>
          )}
          {evidence !== null && (
            <pre className="mt-5 max-h-64 overflow-auto text-xs text-cream/75">
              {JSON.stringify(evidence, null, 2)}
            </pre>
          )}
          <p className="mt-4 text-xs text-cream/55">
            SDK: analyzeRecorderExport(bundle). Opt-in local stdio: --local-evidence. This tool is
            excluded from hosted MCP.
          </p>
        </div>
        <div className="rounded-xl border border-line p-6">
          <p className="station-code text-amber">05 · Local range geometry</p>
          <h2 className="display mt-3 text-2xl">Preserve every bin.</h2>
          <p className="my-4 text-sm text-cream/70">
            Try exact-width recentering, including even ranges. This is geometry; native builds,
            simulation and cost checks remain in the app’s Rebalance Planner.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Lower bin" value={lower} onChange={(e) => setLower(e.target.value)} />
            <Field label="Upper bin" value={upper} onChange={(e) => setUpper(e.target.value)} />
            <Field label="Active bin" value={active} onChange={(e) => setActive(e.target.value)} />
          </div>
          <button
            type="button"
            className={`${btn({ variant: "line" })} mt-4`}
            onClick={() => {
              setRangeError("");
              setGeometry(null);
              try {
                if ([lower, upper, active].some((v) => !/^-?\d+$/.test(v))) throw new Error();
                setGeometry(
                  planRange({ lower: Number(lower), upper: Number(upper), active: Number(active) }),
                );
              } catch {
                setRangeError("Enter whole-number bins and a valid 1–69-bin range.");
              }
            }}
          >
            Calculate geometry
          </button>
          {rangeError && (
            <p role="alert" className="mt-4 text-sm text-amber">
              {rangeError}
            </p>
          )}
          {geometry !== null && (
            <pre className="mt-4 max-h-64 overflow-auto text-xs text-cream/75">
              {JSON.stringify(geometry, null, 2)}
            </pre>
          )}
        </div>
      </section>
      <p className="mt-10 text-sm text-cream/60">
        Build details and source:{" "}
        <a
          href="https://github.com/jjyaz/studio-loco/tree/main/packages/sdk"
          target="_blank"
          rel="noreferrer"
          className="text-amber underline"
        >
          SDK documentation ↗
        </a>{" "}
        ·{" "}
        <a href="/docs#developer-sdk" className="text-amber underline">
          Read contracts
        </a>
      </p>
    </SiteLayout>
  );
}

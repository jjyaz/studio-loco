import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import hero from "@/assets/studio-loco-panoramic-hero.png.asset.json";
import night from "@/assets/studio-loco-night-station.png.asset.json";
import { SiteNav, Footer } from "@/components/site/SiteChrome";
import { RailIcon } from "@/components/site/Wordmark";
import { btn, Cap, Eyebrow } from "@/components/kit";
import { NOTES } from "@/content/journal";
import { distribute } from "@/lib/strategy";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Studio Loco — Good things move together" },
      { name: "description", content: "Shape Meteora DLMM liquidity on Solana, explore private coordination in an honest lab, and build a world on Solana." },
      { property: "og:title", content: "Studio Loco — Good things move together" },
      { property: "og:description", content: "Liquidity terminal, strategy studio and coordination lab for Meteora DLMM on Solana." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:url", content: "https://studioloco.cfd/" },
      { property: "og:image", content: "https://studioloco.cfd/og-card.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Studio Loco: a midnight train crossing golden fields under a cobalt sky, with the line Good things move together." },
      { name: "twitter:image", content: "https://studioloco.cfd/og-card.jpg" },
    ],
    links: [{ rel: "canonical", href: "https://studioloco.cfd/" }],
  }),
  component: Home,
});

function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const f = () => setR(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return r;
}

function Hero() {
  const img = useRef<HTMLImageElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = Math.min(window.scrollY, window.innerHeight);
        if (img.current) img.current.style.transform = `translate3d(0, ${y * 0.18}px, 0) scale(1.04)`;
      });
    };
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [reduced]);

  return (
    <section className="relative h-[90vh] min-h-[560px] w-full overflow-hidden bg-cobalt" aria-label="Studio Loco">
      <img
        ref={img}
        src={hero.url}
        alt="A pixel-art train crosses a golden flower field under a deep blue sky and a single large cloud."
        className="pixelated absolute inset-0 h-full w-full object-cover object-[72%_100%] will-change-transform md:object-[center_100%]"
        style={{ transform: "scale(1.04)" }}
        fetchPriority="high"
      />
      <SiteNav overlay />
      <div className="relative z-10 mx-auto flex h-full max-w-[1400px] flex-col justify-start px-5 pt-32 md:px-10 md:pt-[16vh]">
        <Eyebrow>Solana × Meteora</Eyebrow>
        <h1 className="display mt-5 max-w-[11ch] text-[clamp(3rem,9vw,8.5rem)] text-cream" style={{ textShadow: "0 2px 0 var(--midnight)" }}>
          Good things move together.
        </h1>
        <p className="mt-6 max-w-md text-lg text-cream md:text-xl">Shape liquidity. Explore private coordination. Build a world on Solana.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to="/app" className={btn({ size: "lg" })}>
            Enter the terminal
          </Link>
          <a href="#world" className={cn(btn({ size: "lg", variant: "line" }), "bg-midnight/30")}>
            Explore the world
          </a>
        </div>
      </div>
      <a href="#world" className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 flex-col items-center gap-2 md:flex" aria-label="Scroll to the route index">
        <span className="station-code bg-midnight px-3 py-1 text-cream">Next stop ↓ Route index</span>
        <span className="relative h-10 w-px bg-cream/40">
          <span className="animate-scroll-cue absolute -left-[3px] top-0 size-[7px] bg-amber" />
        </span>
      </a>
    </section>
  );
}

const DESTINATIONS = [
  { code: "ST-01", to: "/app", icon: "train", title: "Liquidity Terminal", body: "Live Meteora DLMM pools with real TVL, volume, fees and bin steps. Swap, add liquidity and manage positions from your own wallet.", cap: "live" },
  { code: "ST-02", to: "/app/studio", icon: "switch", title: "Strategy Studio", body: "Compose Spot, Curve and BidAsk routes across real bins, save and share them, then hand one to the pool flow for signing.", cap: "simulation" },
  { code: "ST-03", to: "/lab", icon: "lab", title: "Coordination Lab", body: "Run secret ballots, sealed-bid aggregates and shared histograms locally to learn how confidential coordination works.", cap: "simulation" },
] as const;

function RouteIndex() {
  return (
    <section id="world" className="relative scroll-mt-4 bg-midnight py-24">
      <div className="mx-auto max-w-[1400px] px-5 md:px-10">
        <Eyebrow>Route index · 3 stops</Eyebrow>
        <h2 className="display mt-4 max-w-3xl text-4xl text-cream md:text-6xl">One line through three real destinations.</h2>
        <div className="relative mt-16">
          <div className="rail-line absolute left-0 right-0 top-[22px] hidden md:block" aria-hidden />
          <ol className="grid gap-8 md:grid-cols-3">
            {DESTINATIONS.map((d) => (
              <li key={d.code} className="relative">
                <div className="mb-6 flex items-center gap-3">
                  <span aria-hidden className="relative z-10 grid size-11 place-items-center border border-cream bg-midnight text-amber">
                    <RailIcon kind={d.icon} />
                  </span>
                  <span className="station-code text-cream/70">{d.code}</span>
                </div>
                <Link to={d.to} className="ticket group block p-6 transition-colors hover:bg-cobalt">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="display text-3xl text-cream">{d.title}</h3>
                    <span aria-hidden className="text-2xl text-amber transition-transform group-hover:translate-x-1">→</span>
                  </div>
                  <p className="mt-4 text-cream/80">{d.body}</p>
                  <Cap kind={d.cap} className="mt-6" />
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function NightStation() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="night-h">
      <img src={night.url} alt="At night, the train waits beside a lit station house with a signal lamp, the golden field glowing below." className="pixelated h-[78vh] min-h-[480px] w-full object-cover object-[65%_center]" loading="lazy" />
      <div className="absolute inset-x-0 top-0 mx-auto max-w-[1400px] px-5 pt-16 md:px-10 md:pt-24">
        <div className="max-w-md">
          <Eyebrow>Night station · Platform 2</Eyebrow>
          <h2 className="display mt-4 text-4xl text-cream md:text-6xl" style={{ textShadow: "0 2px 0 var(--midnight)" }}>
            The lamps stay honest.
          </h2>
          <p className="mt-5 bg-midnight/70 p-4 text-cream">
            Every number in the terminal comes from Meteora's public API or your RPC. When data is missing we print a dash. When a feature is a simulation, the label says so. When something isn't deployed, we don't pretend.
          </p>
          <Link to="/network" className={cn(btn({ variant: "line" }), "mt-6 bg-midnight/40")}>
            Check the signal box status
          </Link>
        </div>
      </div>
    </section>
  );
}

function BinExplainer() {
  const [active, setActive] = useState(0);
  const bins = distribute("Spot", active, -10, 10);
  return (
    <section className="bg-cobalt py-24" aria-labelledby="bins-h">
      <div className="mx-auto grid max-w-[1400px] gap-12 px-5 md:grid-cols-[1fr_1.4fr] md:px-10">
        <div>
          <Eyebrow>Rail explainer</Eyebrow>
          <h2 id="bins-h" className="display mt-4 text-4xl text-cream md:text-5xl">Liquidity sits at stations, not on a curve.</h2>
          <p className="mt-5 text-cream/85">
            A DLMM pool is a line of price bins. The train marks the active bin. Stations ahead of it carry the base token (X); stations behind carry the quote token (Y). Move the train and watch your inventory change sides.
          </p>
          <label htmlFor="train" className="station-code mt-8 block text-cream">
            Active bin offset: <span className="text-amber">{active > 0 ? `+${active}` : active}</span>
          </label>
          <input id="train" type="range" min={-10} max={10} value={active} onChange={(e) => setActive(Number(e.target.value))} className="mt-3 w-full accent-[var(--amber)]" />
          <p className="mt-2 text-xs text-cream/70">Illustration of a 21-bin Spot range. Real pools are drawn from onchain bins.</p>
        </div>
        <div className="ticket bg-midnight p-6">
          <svg viewBox="0 0 420 200" className="w-full" role="img" aria-label={`Bin diagram with active bin at offset ${active}`}>
            {bins.map((b, i) => {
              const x = 10 + i * 19.5;
              const isActive = b.binId === active;
              const hx = b.x * 1400;
              const hy = b.y * 1400;
              return (
                <g key={b.binId}>
                  {hy > 0 && <rect x={x} y={150 - hy - hx} width={15} height={hy} fill="var(--cream)" opacity={0.85} />}
                  {hx > 0 && <rect x={x} y={150 - hx} width={15} height={hx} fill="var(--amber)" />}
                  <rect x={x} y={156} width={15} height={4} fill={isActive ? "var(--amber)" : "var(--line)"} />
                  {isActive && (
                    <g transform={`translate(${x - 6}, 166)`}>
                      <rect width={27} height={12} fill="var(--ochre)" />
                      <rect x={4} y={3} width={4} height={4} fill="var(--cream)" />
                      <rect x={11} y={3} width={4} height={4} fill="var(--cream)" />
                      <rect x={18} y={3} width={4} height={4} fill="var(--cream)" />
                    </g>
                  )}
                </g>
              );
            })}
            <line x1={0} x2={420} y1={162} y2={162} stroke="var(--line)" strokeDasharray="6 4" />
          </svg>
          <div className="mt-4 flex gap-6 station-code text-cream/80">
            <span className="flex items-center gap-2"><span className="size-3 bg-amber" /> Token X (above)</span>
            <span className="flex items-center gap-2"><span className="size-3 bg-cream" /> Token Y (below)</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQ = [
  { q: "Is Studio Loco a DEX?", a: "No. It is an independent interface to Meteora DLMM pools on Solana. Trades and liquidity go directly to Meteora's onchain program from your wallet." },
  { q: "Is there a LOCO token?", a: "No. LOCO has not been deployed and no sale is configured. Anyone offering LOCO is not us." },
  { q: "Does Meteora make my trades private?", a: "No. DLMM is public infrastructure. The Coordination Lab is a local educational simulation and does not provide privacy guarantees." },
  { q: "Do you hold my funds or keys?", a: "Never. There is no custodial backend. Your wallet signs every transaction after we simulate it." },
  { q: "What if data fails to load?", a: "You'll see an explicit error and a retry button. We never swap in fake markets; Practice mode is a separate, opt-in switch." },
];

function Home() {
  return (
    <div>
      <main id="main">
        <Hero />
        <RouteIndex />
        <NightStation />
        <BinExplainer />
        <section className="bg-midnight py-24" aria-labelledby="notes-h">
          <div className="mx-auto max-w-[1400px] px-5 md:px-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow>Field Notes</Eyebrow>
                <h2 id="notes-h" className="display mt-4 text-4xl text-cream md:text-5xl">Notes from the line.</h2>
              </div>
              <Link to="/journal" className={btn({ variant: "line" })}>All field notes</Link>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {NOTES.map((n) => (
                <Link key={n.slug} to="/journal/$slug" params={{ slug: n.slug }} className="ticket group flex flex-col p-6 hover:bg-cobalt">
                  <span className="station-code text-amber">{n.code} · {n.date}</span>
                  <h3 className="mt-4 text-2xl font-semibold leading-tight text-cream">{n.title}</h3>
                  <p className="mt-3 flex-1 text-sm text-cream/75">{n.summary}</p>
                  <span className="station-code mt-6 text-cream group-hover:text-amber">Read note →</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
        <section className="border-t border-line bg-midnight py-24" aria-labelledby="faq-h">
          <div className="mx-auto grid max-w-[1400px] gap-10 px-5 md:grid-cols-[1fr_1.6fr] md:px-10">
            <div>
              <Eyebrow>Information desk</Eyebrow>
              <h2 id="faq-h" className="display mt-4 text-4xl text-cream md:text-5xl">Questions at the platform.</h2>
            </div>
            <div className="divide-y divide-line border-y border-line">
              {FAQ.map((f) => (
                <details key={f.q} className="group py-5">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-lg text-cream">
                    {f.q}
                    <span aria-hidden className="station-code text-amber group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 text-cream/80">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

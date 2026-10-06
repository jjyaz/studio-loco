import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Wordmark } from "./Wordmark";
import { CaButton } from "./CaButton";
import { btn } from "@/components/kit";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", hash: "world", label: "The World" },
  { to: "/app", label: "Liquidity" },
  { to: "/lab", label: "Lab" },
  { to: "/journal", label: "Field Notes" },
] as const;

export function SiteNav({ overlay = false }: { overlay?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <header className={cn("z-40 w-full", overlay ? "absolute inset-x-0 top-0" : "border-b border-line bg-midnight")}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-amber focus:p-2 focus:text-midnight">
        Skip to content
      </a>
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-5 py-4 md:px-10">
        <Link to="/" aria-label="Studio Loco home">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          {NAV.map((n) => (
            <Link key={n.label} to={n.to} hash={"hash" in n ? n.hash : undefined} className="text-sm text-cream/90 hover:text-amber" activeOptions={{ exact: n.to === "/", includeHash: false }}>
              {n.label}
            </Link>
          ))}
          <CaButton />
          <Link to="/app" className={btn({ size: "sm" })}>
            Enter Terminal
          </Link>
        </nav>
        <button type="button" className="station-code min-h-11 border border-line px-3 text-cream md:hidden" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Mobile" className="flex flex-col gap-1 border-t border-line bg-midnight px-5 pb-5 md:hidden">
          {NAV.map((n) => (
            <Link key={n.label} to={n.to} hash={"hash" in n ? n.hash : undefined} onClick={() => setOpen(false)} className="min-h-11 py-3 text-cream">
              {n.label}
            </Link>
          ))}
          <CaButton />
          <Link to="/app" className={cn(btn(), "mt-2")} onClick={() => setOpen(false)}>
            Enter Terminal
          </Link>
        </nav>
      )}
    </header>
  );
}

export function Footer() {
  const cols: { title: string; links: { to: string; label: string; hash?: string }[] }[] = [
    { title: "Product", links: [{ to: "/app", label: "Liquidity Terminal" }, { to: "/app/studio", label: "Strategy Studio" }, { to: "/app/signals", label: "Signal Box" }, { to: "/app/launch", label: "Launch Station" }] },
    { title: "World", links: [{ to: "/lab", label: "Coordination Lab" }, { to: "/governance", label: "Decision Room" }, { to: "/token", label: "LOCO worksheet" }, { to: "/journal", label: "Field Notes" }] },
    { title: "Help", links: [{ to: "/docs", label: "Docs" }, { to: "/network", label: "Status" }, { to: "/docs", hash: "risk", label: "Risk information" }, { to: "/docs", hash: "privacy", label: "Privacy distinction" }] },
  ];
  return (
    <footer className="border-t border-line bg-midnight">
      <div className="mx-auto grid max-w-[1400px] gap-10 px-5 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:px-10">
        <div>
          <Wordmark size="md" />
          <p className="mt-4 max-w-sm text-sm text-cream/70">
            An independent interface for Meteora DLMM on Solana, with an educational coordination lab. Not affiliated with Meteora.
          </p>
          <p className="mt-4 station-code text-cream/50">DLMM program LBUZKhRx…Pwxo</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="station-code text-amber">{c.title}</p>
            <ul className="mt-4 flex flex-col gap-2">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link to={l.to} hash={l.hash} className="text-sm text-cream/85 hover:text-amber">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="rail-line mx-auto max-w-[1400px]" />
      <p className="mx-auto max-w-[1400px] px-5 py-6 text-xs text-cream/55 md:px-10">
        Providing liquidity carries risk of loss, including impermanent loss and smart-contract risk. Nothing here is financial advice. Simulations are illustrative.
      </p>
    </footer>
  );
}

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteNav />
      <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-10 md:px-10">
        {children}
      </main>
      <Footer />
    </div>
  );
}

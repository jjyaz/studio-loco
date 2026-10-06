import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Wordmark } from "@/components/site/Wordmark";
import { WalletButton } from "@/components/wallet/WalletButton";
import { Btn, Field, Segmented } from "@/components/kit";
import { DEFAULT_RPC, SLIPPAGE_PRESETS, useSettings, validateRpc, type Cluster } from "@/lib/settings";

const TABS = [
  { to: "/app", label: "Terminal", exact: true },
  { to: "/app/portfolio", label: "Portfolio" },
  { to: "/app/studio", label: "Studio" },
  { to: "/app/signals", label: "Signals" },
  { to: "/app/launch", label: "Launch" },
] as const;

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { settings, update } = useSettings();
  const [rpc, setRpc] = useState(settings.rpc);
  const [slip, setSlip] = useState(String(settings.slippageBps / 100));
  const rpcErr = { "mainnet-beta": validateRpc(rpc["mainnet-beta"]), devnet: validateRpc(rpc.devnet) };
  const slipNum = Number(slip);
  const slipErr = !Number.isFinite(slipNum) || slipNum <= 0 || slipNum > 50 ? "Slippage must be between 0.01% and 50%" : null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (o) { setRpc(settings.rpc); setSlip(String(settings.slippageBps / 100)); } onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-none border-line bg-midnight text-cream">
        <DialogTitle className="display text-2xl">Terminal settings</DialogTitle>
        <DialogDescription className="text-cream/75">Stored only in this browser.</DialogDescription>
        <div className="flex flex-col gap-5">
          <div>
            <p className="station-code mb-2 text-cream/80">Cluster</p>
            <Segmented<Cluster> label="Cluster" value={settings.cluster} onChange={(c) => update({ cluster: c })} options={[{ value: "mainnet-beta", label: "Mainnet" }, { value: "devnet", label: "Devnet" }]} />
            <p className="mt-2 text-xs text-cream/65">The Meteora pool list API is mainnet-only. On devnet, open pools by address.</p>
          </div>
          {(["mainnet-beta", "devnet"] as const).map((c) => (
            <Field key={c} label={`${c === "devnet" ? "Devnet" : "Mainnet"} RPC (HTTPS)`} placeholder={DEFAULT_RPC[c]} value={rpc[c]} onChange={(e) => setRpc({ ...rpc, [c]: e.target.value.trim() })} error={rpcErr[c]} hint="Leave empty for the public endpoint. Keys in URLs stay in this browser only." />
          ))}
          <div>
            <p className="station-code mb-2 text-cream/80">Slippage</p>
            <div className="flex flex-wrap gap-2">
              {SLIPPAGE_PRESETS.map((b) => (
                <button key={b} type="button" onClick={() => setSlip(String(b / 100))} className={`station-code min-h-10 border px-3 ${Number(slip) * 100 === b ? "border-amber bg-amber text-midnight" : "border-line"}`}>
                  {b / 100}%
                </button>
              ))}
            </div>
            <Field className="mt-3" label="Custom slippage" suffix="%" value={slip} onChange={(e) => setSlip(e.target.value)} error={slipErr} inputMode="decimal" />
          </div>
          <label className="flex min-h-11 items-center justify-between gap-3 border border-line px-4">
            <span>
              <span className="block">Practice mode</span>
              <span className="text-xs text-cream/65">Shows seeded fictional pools. Nothing can be transacted.</span>
            </span>
            <input type="checkbox" className="size-5 accent-[var(--amber)]" checked={settings.practice} onChange={(e) => update({ practice: e.target.checked })} />
          </label>
          <Btn
            disabled={!!rpcErr["mainnet-beta"] || !!rpcErr.devnet || !!slipErr}
            onClick={() => {
              update({ rpc, slippageBps: Math.round(slipNum * 100) });
              onOpenChange(false);
            }}
          >
            Save settings
          </Btn>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen flex-col bg-midnight">
      <a href="#app-main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-amber focus:p-2 focus:text-midnight">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-midnight">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex items-center gap-5">
            <Link to="/" aria-label="Studio Loco home"><Wordmark size="sm" /></Link>
            <span className="station-code hidden border border-line px-2 py-1 text-cream/75 sm:inline">{settings.cluster === "devnet" ? "Devnet" : "Mainnet"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Btn size="sm" variant="line" onClick={() => setOpen(true)} aria-label="Open settings">Settings</Btn>
            <WalletButton compact />
          </div>
        </div>
        <nav aria-label="Terminal sections" className="mx-auto flex max-w-[1500px] gap-1 overflow-x-auto px-4 md:px-8">
          {TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              activeOptions={{ exact: "exact" in t }}
              className="station-code min-h-11 whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-cream/75 hover:text-cream"
              activeProps={{ className: "!border-amber !text-amber" }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      {settings.practice && (
        <div className="bg-ochre px-4 py-2 text-center text-sm text-midnight" role="status">
          Practice mode is on — the terminal list shows fictional seeded pools.{" "}
          <button type="button" className="underline" onClick={() => update({ practice: false })}>Return to live data</button>
        </div>
      )}
      <main id="app-main" className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-8 md:px-8">{children}</main>
      <footer className="border-t border-line px-4 py-5 text-center text-xs text-cream/55">
        Independent interface for Meteora DLMM · <Link to="/docs" hash="risk" className="underline">Risk information</Link> · <Link to="/network" className="underline">Status</Link> · <Link to="/docs" className="underline">Docs</Link>
      </footer>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

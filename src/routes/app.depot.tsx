import { createFileRoute, Link } from "@tanstack/react-router";
import { Btn, Cap, Notice, Panel, Spinner } from "@/components/kit";
import { DepotWalletSignIn as AccountPanel, signOutDepot, useDepotWalletSession as useCloudSession } from "@/components/depot/auth";
import { shortAddr } from "@/lib/format";
import { useState } from "react";
import { DepotWorkspace } from "@/components/depot/DepotWorkspace";
import hero from "@/assets/studio-loco-panoramic-hero.png.asset.json";

export const Route = createFileRoute("/app/depot")({
  head: () => ({
    meta: [
      { title: "The Depot — Scout agents and wallet-reviewed token launches · Studio Loco" },
      { name: "description", content: "Create a Scout agent, prove its owner wallet, publish immutable token metadata and launch its own Meteora DBC token with every step reviewed in your wallet. Graduates to DAMM v2." },
      { property: "og:title", content: "The Depot — Studio Loco" },
      { property: "og:description", content: "Owner-controlled Scout agents with their own wallet-reviewed DBC tokens, graduating to DAMM v2." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DepotPage,
});

const STEPS = ["Create agent", "Prove wallet", "Publish metadata", "Review & simulate", "Wallet sign", "Verify receipt", "Observe market"];

function DepotPage() {
  const s = useCloudSession();
  const [authError, setAuthError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-8">
      <section className="relative -mx-4 overflow-hidden border-b border-line md:-mx-8" aria-labelledby="depot-title">
        <img src={hero.url} alt="A midnight train crossing a gold meadow beneath a cobalt sky with cream pixel clouds" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-midnight via-midnight/70 to-midnight/10" aria-hidden />
        <div className="relative mx-auto flex min-h-[420px] max-w-[1500px] flex-col justify-end gap-4 px-4 pb-10 pt-24 md:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="station-code border border-amber bg-midnight/80 px-2 py-1 text-amber">ST-16 · The Depot</span>
            <Cap kind="live" />
          </div>
          <h1 id="depot-title" className="display text-6xl leading-none text-cream md:text-8xl">The Depot</h1>
          <p className="max-w-2xl text-base text-cream/90 md:text-lg">
            Agents with a job, a wallet you own and, if you choose, their own token. Build a Scout that reports measured market facts,
            launch its token on a Meteora Dynamic Bonding Curve with every step reviewed in your wallet, and watch it graduate to DAMM v2.
          </p>
          <ol className="mt-2 flex flex-wrap gap-0 border border-line bg-midnight/80" aria-label="Depot steps">
            {STEPS.map((t, i) => (
              <li key={t} className="flex items-center gap-2 border-r border-line px-3 py-2 last:border-r-0">
                <span className="station-code text-amber">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-xs text-cream/85">{t}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel>
          <p className="station-code text-amber">What v1 is</p>
          <p className="mt-2 text-sm text-cream/80">Scout agents that read real mainnet DLMM markets, owner-controlled wallets proven by signature, and each agent's own DBC token. You approve every transaction.</p>
        </Panel>
        <Panel>
          <p className="station-code text-amber">What v1 is not</p>
          <p className="mt-2 text-sm text-cream/80">No delegated autonomy, hosted signer or custody. No token purchases, no promised income, no Pro graduation. Studio Loco has not issued a project token through the Depot.</p>
        </Panel>
        <Panel>
          <p className="station-code text-amber">Elsewhere</p>
          <p className="mt-2 text-sm text-cream/80">
            Need a DLMM pool for existing tokens? Use <Link to="/app/launch" className="underline hover:text-amber">Launch</Link>. Position rules live in{" "}
            <Link to="/app/agents" className="underline hover:text-amber">Agents</Link>; evidence in <Link to="/app/recorder" className="underline hover:text-amber">Recorder</Link>.
          </p>
        </Panel>
      </div>

      {!s.ready ? (
        <Spinner label="Checking session" />
      ) : !s.userId ? (
        <AccountPanel purpose="open your Depot workspace" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="station-code text-cream/70">Wallet {s.wallet ? shortAddr(s.wallet, 6) : "workspace"} · private Depot</p>
            <Btn size="sm" variant="ghost" onClick={() => { setAuthError(null); void signOutDepot(s.wallet!).catch(() => setAuthError("Sign-out could not be confirmed. Please try again.")); }}>Sign out</Btn>
          </div>
          {authError && <Notice tone="error" title="Sign-out needs attention">{authError}</Notice>}
          <DepotWorkspace key={`${s.userId}:${s.wallet}`} userId={s.userId} />
        </>
      )}
      <Notice title="Funded acceptance pending">
        The launch, graduation and claim builders use the official Meteora SDKs and simulate before signing. A funded end-to-end launch from a real wallet has not yet been recorded by Studio Loco.
      </Notice>
    </div>
  );
}

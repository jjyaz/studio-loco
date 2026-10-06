import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { planKey, usePlan } from "@/lib/plan";
import { simulateExact } from "@/lib/tx";
import BN from "bn.js";
import type { Transaction } from "@solana/web3.js";
import { Btn, Cap, Field, Notice, PageHead, Panel, Spinner } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { fetchMint, type MintInfo } from "@/lib/chain";
import { baseFeePct, uiPriceFromBin } from "@/lib/bins";
import { loadSdk } from "@/lib/dlmm";
import { fmtNum, shortAddr } from "@/lib/format";
import { redactUrls } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/launch")({
  head: () => ({
    meta: [
      { title: "Launch Station — Studio Loco" },
      { name: "description", content: "Create a Meteora DLMM pool with onchain mint validation, real preset parameters, a duplicate check and the official createLbPair2 transaction." },
      { property: "og:title", content: "Launch Station — Studio Loco" },
      { property: "og:description", content: "A real DLMM pool creation wizard. No invented tokens." },
    ],
  }),
  component: Launch,
});

interface Preset { key: string; binStep: number; baseFactor: number; power: number; fn: number; collect: number; fee: number }

function Launch() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  const runner = useTxRunner();
  const [xAddr, setXAddr] = useState("");
  const [yAddr, setYAddr] = useState("");
  const [mx, setMx] = useState<MintInfo | null>(null);
  const [my, setMy] = useState<MintInfo | null>(null);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [preset, setPreset] = useState<string>("");
  const [price, setPrice] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const presets = useQuery({
    queryKey: ["presets", connection.rpcEndpoint, settings.cluster],
    queryFn: async (): Promise<Preset[]> => {
      const sdk = await loadSdk();
      const all = await sdk.default.getAllPresetParameters(connection, { cluster: settings.cluster });
      return all.presetParameter2
        .map((p) => ({ key: p.publicKey.toBase58(), binStep: p.account.binStep, baseFactor: p.account.baseFactor, power: p.account.baseFeePowerFactor, fn: p.account.concreteFunctionType, collect: p.account.collectFeeMode, fee: baseFeePct(p.account.baseFactor, p.account.binStep, p.account.baseFeePowerFactor) }))
        .sort((a, b) => a.binStep - b.binStep || a.fee - b.fee);
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Mints validated on one cluster/RPC are not valid evidence on another.
  useEffect(() => { setMx(null); setMy(null); }, [settings.cluster, connection.rpcEndpoint]);
  const liveKey = planKey({ x: mx?.address, y: my?.address, preset, price, cluster: settings.cluster, rpc: connection.rpcEndpoint, wallet: publicKey?.toBase58() });
  type Review = { tx: Transaction; pair: string; activeId: number; sim: string | null; actualPrice: number; requested: string; preset: Preset; x: MintInfo; y: MintInfo; cluster: string };
  const { plan: review, begin } = usePlan<Review>(liveKey);

  async function checkMints() {
    setChecking(true); setMintErr(null); setMx(null); setMy(null);
    try {
      if (xAddr.trim() === yAddr.trim()) throw new Error("Base and quote mints must differ");
      const [a, b] = await Promise.all([fetchMint(connection, xAddr).catch((e) => { throw new Error(`Base: ${e.message}`); }), fetchMint(connection, yAddr).catch((e) => { throw new Error(`Quote: ${e.message}`); })]);
      setMx(a); setMy(b);
    } catch (e) { setMintErr(e instanceof Error ? e.message : String(e)); } finally { setChecking(false); }
  }

  const sel = presets.data?.find((p) => p.key === preset);
  const priceNum = Number(price);
  const priceErr = price && !(priceNum > 0 && Number.isFinite(priceNum)) ? "Price must be a positive number" : null;
  const blocked = [...(mx?.blockedExtensions ?? []), ...(my?.blockedExtensions ?? [])];
  const ready = blocked.length === 0 && !!mx && !!my && !!sel && priceNum > 0 && !priceErr && !!publicKey;

  async function build() {
    if (!mx || !my || !sel || !publicKey || busy) return;
    const job = begin();
    const frozen = { x: mx, y: my, preset: sel, requested: price, cluster: settings.cluster };
    setBusy(true); setErr(null);
    try {
      const sdk = await loadSdk();
      const { PublicKey } = await import("@solana/web3.js");
      const DLMM = sdk.default;
      const perLamport = DLMM.getPricePerLamport(mx.decimals, my.decimals, priceNum);
      const activeId = DLMM.getBinIdFromPrice(perLamport, sel.binStep, true);
      const programId = new PublicKey(sdk.LBCLMM_PROGRAM_IDS[settings.cluster]);
      const [pair] = sdk.deriveLbPairWithPresetParamWithIndexKey(new PublicKey(sel.key), new PublicKey(mx.address), new PublicKey(my.address), programId);
      const existing = await connection.getAccountInfo(pair);
      if (existing) throw new Error(`A pool already exists for this mint pair and preset: ${pair.toBase58()}`);
      const tx = await DLMM.createLbPair2(connection, publicKey, new PublicKey(mx.address), new PublicKey(my.address), new PublicKey(sel.key), new BN(activeId), { cluster: settings.cluster });
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.feePayer = publicKey;
      const sim = await simulateExact(connection, tx.serializeMessage());
      job.commit({ ...frozen, tx, pair: pair.toBase58(), activeId, actualPrice: uiPriceFromBin(activeId, sel.binStep, mx.decimals, my.decimals), sim: sim.value.err ? `${JSON.stringify(sim.value.err)} — ${(sim.value.logs ?? []).slice(-3).join(" | ")}` : null });
    } catch (e) { if (job.isCurrent()) setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHead code="ST-06 · Launch Station" title="Lay new track." intro="Create a DLMM pool for two existing tokens. Studio Loco does not create or promote any token." cap={["live"]} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 className="station-code text-amber">1 · Mints ({settings.cluster === "devnet" ? "devnet" : "mainnet"})</h2>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="Base token (X) mint" value={xAddr} onChange={(e) => { setXAddr(e.target.value.trim()); setMx(null); }} placeholder="Mint address" />
            <Field label="Quote token (Y) mint" value={yAddr} onChange={(e) => { setYAddr(e.target.value.trim()); setMy(null); }} placeholder="e.g. USDC mint" />
            <Btn variant="quiet" onClick={checkMints} disabled={!xAddr || !yAddr || checking}>{checking ? "Reading chain…" : "Validate mints onchain"}</Btn>
            {mintErr && <p role="alert" className="text-sm text-destructive">{mintErr}</p>}
            {mx && my && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {[["X", mx], ["Y", my]].map(([k, m]) => { const mi = m as MintInfo; return (
                  <div key={k as string} className="contents">
                    <dt className="text-cream/65">{k as string}</dt>
                    <dd className="font-mono">{shortAddr(mi.address, 6)} · {mi.decimals} decimals · {mi.program}{mi.freezeAuthority ? " · freeze authority set ⚠" : ""}{mi.extensions.length ? ` · ext: ${mi.extensions.join(", ")}` : ""}{mi.blockedExtensions.length ? ` · blocked: ${mi.blockedExtensions.join(", ")}` : ""}</dd>
                  </div>); })}
              </dl>
            )}
            <p className="text-xs text-cream/60">Orientation matters: price is entered as Y per X. Token-2022 mints with unsupported extensions are rejected by the program during simulation.</p>
          </div>

          <h2 className="mt-6 station-code text-amber">2 · Preset (PresetParameter2, onchain)</h2>
          {presets.isPending && <Spinner label="Fetching presets" />}
          {presets.isError && <Notice tone="error" title="Couldn't fetch presets" action={<Btn size="sm" onClick={() => presets.refetch()}>Retry</Btn>}>{redactUrls(String(((presets.error) as Error)?.message ?? ""))}. This uses getProgramAccounts; a dedicated RPC may be required.</Notice>}
          {presets.data && (
            <div className="mt-3 max-h-64 overflow-auto border border-line">
              {presets.data.map((p) => (
                <label key={p.key} className={cn("flex min-h-11 cursor-pointer items-center justify-between gap-2 border-b border-line/50 px-3 text-sm", preset === p.key && "bg-muted")}>
                  <span className="flex items-center gap-2"><input type="radio" name="preset" checked={preset === p.key} onChange={() => setPreset(p.key)} className="accent-[var(--amber)]" />Bin step {p.binStep} · base fee {fmtNum(p.fee, 4)}%</span>
                  <span className="station-code text-cream/60">{p.fn === 0 ? "Limit order" : "Liq. mining"}{p.collect === 1 ? " · fee in Y" : ""}</span>
                </label>
              ))}
            </div>
          )}

          <h2 className="mt-6 station-code text-amber">3 · Initial price</h2>
          <Field className="mt-3" label={`Price (${my ? "quote" : "Y"} per 1 base)`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={priceErr} hint="Converted to an active bin with both tokens' decimals; rounded to the nearest bin at or below." />
          <div className="mt-4">{publicKey ? <Btn onClick={build} disabled={!ready || busy}>{busy ? "Building…" : "Review pool creation"}</Btn> : <WalletButton />}</div>
          {err && <div className="mt-3"><Notice tone="error" title="Can't create this pool">{err}</Notice></div>}
        </Panel>

        <div className="flex flex-col gap-6">
          {review && (
            <Panel tone="cobalt">
              <h3 className="display text-2xl">Review</h3>
              <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-cream/70">New pool</dt><dd className="font-mono">{shortAddr(review.pair, 6)}</dd>
                <dt className="text-cream/70">Base / quote</dt><dd className="font-mono">{shortAddr(review.x.address)} ({review.x.decimals}d) / {shortAddr(review.y.address)} ({review.y.decimals}d)</dd>
                <dt className="text-cream/70">Bin step</dt><dd className="font-mono">{review.preset.binStep} bps</dd>
                <dt className="text-cream/70">Base fee</dt><dd className="font-mono">{fmtNum(review.preset.fee, 4)}%</dd>
                <dt className="text-cream/70">Cluster</dt><dd className="font-mono">{review.cluster}</dd>
                <dt className="text-cream/70">Active bin</dt><dd className="font-mono">{review.activeId}</dd>
                <dt className="text-cream/70">Start price</dt><dd className="font-mono">{fmtNum(review.actualPrice, 8)} (requested {review.requested})</dd>
              </dl>
              <p className="mt-3 text-xs text-cream/70">Creates the pool, reserves and oracle accounts (rent paid by you). It does not add liquidity.</p>
              {review.sim ? <Notice tone="error" title="Simulation failed — not sent">{review.sim}</Notice> : <p className="mt-3 station-code text-success">Simulation passed</p>}
              <Btn className="mt-4 w-full" disabled={!!review.sim || runner.running} onClick={() => runner.run([{ label: "Create DLMM pool (createLbPair2)", tx: review.tx }])}>Sign & send</Btn>
              {!!runner.steps?.length && runner.steps.every((s) => s.phase === "confirmed") && <Link to="/app/pool/$address" params={{ address: review.pair }} search={{ tab: "add" }} className="mt-3 inline-block underline">Seed liquidity in the new pool →</Link>}
            </Panel>
          )}
          <TxSteps steps={runner.steps} />
          <Panel>
            <h3 className="station-code text-amber">Other Meteora infrastructure</h3>
            <ul className="mt-3 flex flex-col gap-3 text-sm text-cream/80">
              <li><strong className="text-cream">Dynamic Bonding Curve (DBC)</strong> — token launch curve that graduates to DAMM (not DLMM). Configure via Meteora's DBC SDK/config keys.</li>
              <li><strong className="text-cream">DAMM v2</strong> — constant-product AMM with dynamic fees; separate program and SDK.</li>
              <li><strong className="text-cream">Alpha Vault</strong> — pre-activation deposit vault attached to a pool; needs its own configuration and permissioned pool settings.</li>
            </ul>
            <p className="mt-3 text-xs text-cream/60">These are documented handoffs only — no adapters are implemented here. <a className="underline" href="https://docs.meteora.ag" target="_blank" rel="noreferrer">Meteora docs ↗</a></p>
            <div className="mt-3"><Cap kind="handoff" /></div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

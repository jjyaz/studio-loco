import { createFileRoute, Link } from "@tanstack/react-router";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { Btn, Notice, PageHead, Panel, Spinner, Stat, btn } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { TxSteps, useTxRunner } from "@/components/app/useTx";
import { useSettings } from "@/lib/settings";
import { GENESIS, browserPendingStore } from "@/lib/tx";
import { JobControl } from "@/lib/job-control";
import { knownLamports, rpcIdentity } from "@/lib/agents";
import { formatUnits } from "@/lib/amount";
import { redactUrls } from "@/lib/format";
import {
  prepareWalletRehearsal,
  rehearsalStaleReason,
  REHEARSAL_MEMO,
  type WalletRehearsal,
} from "@/lib/wallet-rehearsal";

export const Route = createFileRoute("/app/checks")({
  head: () => ({
    meta: [
      { title: "Wallet Checks — Studio Loco" },
      {
        name: "description",
        content:
          "Verify your RPC network and rehearse the real devnet wallet approval flow before a liquidity move.",
      },
    ],
  }),
  component: WalletChecks,
});

export function WalletChecks() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { settings } = useSettings();
  const runner = useTxRunner();
  const [ctl] = useState(() => new JobControl());
  const [, redraw] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<WalletRehearsal | null>(null);
  const [network, setNetwork] = useState<{
    genesis: string;
    slot: number;
    balance: number | null;
    cluster: string;
  } | null>(null);
  const owner = wallet.publicKey?.toBase58() ?? "";
  const identity = `${owner}|${settings.cluster}|${rpcIdentity(settings.rpc[settings.cluster])}|${settings.practice}`;
  const latest = useRef(identity);
  latest.current = identity;
  const live = useRef({
    owner,
    cluster: settings.cluster,
    rpcId: rpcIdentity(settings.rpc[settings.cluster]),
    gen: ctl.gen,
    practice: settings.practice,
  });
  live.current = {
    owner,
    cluster: settings.cluster,
    rpcId: rpcIdentity(settings.rpc[settings.cluster]),
    gen: ctl.gen,
    practice: settings.practice,
  };
  useEffect(() => {
    ctl.mounted = true;
    const unsub = ctl.subscribe(() => redraw((n) => n + 1));
    return () => {
      unsub();
      ctl.unmount();
    };
  }, [ctl]);
  useEffect(() => {
    ctl.invalidate();
    live.current.gen = ctl.gen;
    setReview(null);
    setNetwork(null);
    setError(null);
  }, [identity, ctl]);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [review]);
  const unresolved =
    owner &&
    browserPendingStore.list().some((p) => p.wallet === owner && p.cluster === settings.cluster);
  const unavailable = !runner.canSign
    ? "Connect a wallet that supports transaction signing."
    : settings.cluster !== "devnet"
      ? "Switch to Devnet in Settings for a fee-only wallet rehearsal."
      : settings.practice
        ? "Turn off Practice in Settings to rehearse a real devnet transaction."
        : unresolved
          ? "Check the unresolved transaction first."
          : null;
  const stale = review ? rehearsalStaleReason(review, live.current, now) : null;

  async function checkNetwork() {
    const job = ctl.begin();
    if (!job) return;
    const started = identity;
    setError(null);
    setNetwork(null);
    try {
      const genesis = await job.step(connection.getGenesisHash(), 15_000, "Reading genesis");
      if (genesis !== GENESIS[settings.cluster])
        throw new Error(
          "The endpoint's genesis hash does not match the selected network. Check Settings.",
        );
      const slot = await job.step(connection.getSlot("confirmed"), 15_000, "Reading slot");
      const balance = wallet.publicKey
        ? await job.step(
            connection.getBalance(wallet.publicKey, "confirmed"),
            15_000,
            "Reading SOL balance",
          )
        : null;
      job.check();
      if (latest.current === started)
        setNetwork({
          genesis,
          slot,
          balance: knownLamports(balance) ? balance : null,
          cluster: settings.cluster,
        });
    } catch (e) {
      if (job.alive() && latest.current === started)
        setError(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      ctl.end(job);
    }
  }
  async function prepare() {
    if (unavailable || runner.running) return;
    const job = ctl.begin();
    if (!job) return;
    const started = identity;
    setError(null);
    setReview(null);
    runner.reset();
    try {
      const result = await prepareWalletRehearsal({
        connection,
        owner,
        cluster: settings.cluster,
        rpcId: live.current.rpcId,
        job,
      });
      job.check();
      if (latest.current === started) {
        setNow(Date.now());
        setReview(result);
      }
    } catch (e) {
      if (job.alive() && latest.current === started)
        setError(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      ctl.end(job);
    }
  }
  async function approve() {
    if (!review || unavailable || stale || runner.running || ctl.busy) return;
    const frozen = review;
    const started = identity;
    setError(null);
    try {
      await runner.run([{ label: "Devnet wallet rehearsal · memo only", tx: frozen.tx }], {
        maxFeeLamports: frozen.feeLamports,
        semanticGuard: () =>
          latest.current !== started
            ? "Settings changed. Open a fresh rehearsal."
            : rehearsalStaleReason(frozen, { ...live.current, gen: ctl.gen }, Date.now()),
      });
    } catch (e) {
      setError(redactUrls(e instanceof Error ? e.message : String(e)));
    } finally {
      setReview(null);
    }
  }
  return (
    <div>
      <PageHead
        code="ST-09 · Wallet Checks"
        title="Before departure."
        intro="Verify the network, then rehearse a real wallet approval on devnet. Each rehearsal writes one public memo and spends only the reviewed devnet network fee."
        cap={["live"]}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <p className="station-code text-amber">01 · Check the connection</p>
          <h2 className="display mt-3 text-2xl">Know which network you are on.</h2>
          <p className="mt-3 text-sm text-cream/75">
            A fresh genesis read verifies the endpoint rather than trusting its label. You can run
            this without a wallet.
          </p>
          <div className="my-5 grid grid-cols-2 gap-4">
            <Stat
              label="Selected network"
              value={settings.cluster === "devnet" ? "Devnet" : "Mainnet"}
            />
            <Stat
              label="Wallet signing"
              value={!owner ? "Disconnected" : runner.canSign ? "Available" : "Unsupported"}
            />
          </div>
          <Btn variant="line" onClick={checkNetwork} disabled={ctl.busy || runner.running}>
            Check connection
          </Btn>
          {network && (
            <div className="mt-5 border-t border-line pt-4" role="status">
              <p className="station-code text-success">Genesis verified · {network.cluster}</p>
              <p className="mt-2 break-all font-mono text-xs text-cream/75">{network.genesis}</p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Stat label="Confirmed slot" value={network.slot.toLocaleString()} />
                <Stat
                  label="Wallet SOL"
                  value={
                    network.balance === null
                      ? "Unavailable"
                      : formatUnits(BigInt(network.balance), 9)
                  }
                />
              </div>
            </div>
          )}
        </Panel>
        <Panel tone="cobalt">
          <p className="station-code text-amber">02 · Rehearse the wallet</p>
          <h2 className="display mt-3 text-2xl">A small test. A real receipt.</h2>
          <p className="mt-3 text-sm text-cream/80">
            No token transfer, liquidity move or account creation. Review the fee, then approve or
            decline in your wallet. There is no automatic retry.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {!owner && <WalletButton />}
            <Btn disabled={!!unavailable || ctl.busy || runner.running} onClick={prepare}>
              Prepare devnet rehearsal
            </Btn>
          </div>
          {unavailable && <p className="mt-3 text-sm text-cream/75">{unavailable}</p>}
          {review && (
            <div className="mt-5 border border-cream/30 p-4">
              <p className="station-code text-amber">
                Frozen devnet review ·{" "}
                {Math.max(0, Math.ceil((20_000 - (now - review.builtAt)) / 1000))}s remaining
              </p>
              <div className="my-4 grid grid-cols-2 gap-4">
                <Stat
                  label="Network fee"
                  value={`${formatUnits(BigInt(review.feeLamports), 9)} SOL`}
                />
                <Stat
                  label="Simulation"
                  value="Passed"
                  sub={`${review.units.toLocaleString()} compute units`}
                />
              </div>
              <p className="break-all text-xs text-cream/80">Fee payer: {review.owner}</p>
              <p className="mt-3 text-xs text-cream/75">Public memo: {REHEARSAL_MEMO}</p>
              {stale && (
                <p className="mt-3 text-sm text-amber" role="status">
                  {stale}
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <Btn
                  disabled={!!stale || !!unavailable || ctl.busy || runner.running}
                  onClick={approve}
                >
                  Approve in wallet
                </Btn>
                <Btn
                  variant="ghost"
                  disabled={runner.running}
                  onClick={() => {
                    ctl.invalidate();
                    setReview(null);
                  }}
                >
                  Discard review
                </Btn>
              </div>
            </div>
          )}
          <TxSteps steps={runner.steps} />
        </Panel>
      </div>
      {ctl.busy && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Spinner
            label={
              ctl.draining && !ctl.running
                ? "Waiting for the RPC request to finish"
                : "Checking fresh state"
            }
          />
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => {
              ctl.invalidate();
              setReview(null);
            }}
          >
            Cancel check
          </Btn>
        </div>
      )}
      {error && (
        <div className="mt-5">
          <Notice tone="error" title="Check stopped">
            {error}
          </Notice>
        </div>
      )}
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <Panel>
          <p className="station-code text-amber">Wallet acceptance checklist</p>
          <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm text-cream/80">
            <li>Prepare, then decline in the wallet. Expect “Declined”, with no signature.</li>
            <li>Let the review expire. A fresh review is required.</li>
            <li>
              While the wallet prompt is open, switch wallet or network, or navigate away. Any
              returned approval must be discarded before broadcast.
            </li>
            <li>Approve a fresh devnet rehearsal. Expect a confirmed receipt and explorer link.</li>
            <li>If settlement is unknown, reload and use “Check status”. Do not resend.</li>
          </ol>
          <p className="mt-4 text-xs text-cream/65">
            These checks require your browser wallet. A simulation or mocked test does not count as
            a completed wallet rehearsal.
          </p>
        </Panel>
        <Panel>
          <p className="station-code text-amber">03 · Your mainnet pilot</p>
          <h2 className="display mt-3 text-2xl">One reviewed native move.</h2>
          <p className="mt-3 text-sm text-cream/80">
            After rehearsing, open one of your existing mainnet DLMM positions in The Observatory.
            Review the exact range, strategy, token top-up, fee and rent. Use an amount you choose,
            approve it in your own wallet, then verify the confirmed position and preserved WSOL
            balance.
          </p>
          <p className="mt-3 text-xs text-cream/70">
            Funded devnet validation is complete. Browser-wallet acceptance and your first funded
            mainnet move remain user-run checks. DLMM Pro is a separate integration.
          </p>
          <Link to="/app/agents" className={btn({ variant: "line", className: "mt-5" })}>
            Open The Observatory
          </Link>
        </Panel>
      </div>
    </div>
  );
}

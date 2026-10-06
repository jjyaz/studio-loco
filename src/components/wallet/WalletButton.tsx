import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Btn } from "@/components/kit";
import { shortAddr } from "@/lib/format";

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { wallets, select, connect, disconnect, publicKey, connecting, wallet } = useWallet();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (publicKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="station-code border border-line px-2 py-2 text-cream" title={publicKey.toBase58()}>
          {wallet?.adapter.name} · {shortAddr(publicKey.toBase58())}
        </span>
        <Btn size="sm" variant="line" onClick={() => disconnect()}>
          Disconnect
        </Btn>
      </div>
    );
  }

  const listed = wallets.filter((w) => w.readyState !== WalletReadyState.Unsupported);
  return (
    <>
      <Btn size={compact ? "sm" : "md"} onClick={() => { setErr(null); setOpen(true); }} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </Btn>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none border-line bg-midnight text-cream">
          <DialogTitle className="display text-2xl">Connect a Solana wallet</DialogTitle>
          <DialogDescription className="text-cream/75">
            Studio Loco never asks for a seed phrase or private key. Your wallet signs every transaction itself.
          </DialogDescription>
          <ul className="mt-2 flex flex-col gap-2">
            {listed.map((w) => {
              const installed = w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;
              return (
                <li key={w.adapter.name}>
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center justify-between border border-line px-4 text-left hover:border-amber"
                    onClick={async () => {
                      setErr(null);
                      try {
                        select(w.adapter.name);
                        await w.adapter.connect();
                        setOpen(false);
                      } catch (e) {
                        setErr(e instanceof Error ? e.message || "Connection was cancelled" : "Connection failed");
                      }
                    }}
                  >
                    <span className="flex items-center gap-3">
                      {w.adapter.icon && <img src={w.adapter.icon} alt="" className="size-6" />}
                      {w.adapter.name}
                    </span>
                    <span className="station-code text-cream/60">{installed ? "Detected" : "Open"}</span>
                  </button>
                </li>
              );
            })}
            {!wallets.some((w) => w.adapter.name === "Phantom") && (
              <li>
                <a className="flex min-h-12 items-center justify-between border border-dashed border-line px-4 hover:border-amber" href="https://phantom.com/download" target="_blank" rel="noreferrer">
                  Phantom <span className="station-code text-cream/60">Not detected · install</span>
                </a>
              </li>
            )}
          </ul>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          {/* connect is exposed for adapters that need it after select */}
          <span className="hidden">{String(!!connect)}</span>
        </DialogContent>
      </Dialog>
    </>
  );
}

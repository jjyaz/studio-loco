import { installNodeGlobals } from "@/lib/polyfills";
installNodeGlobals();
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useSettings } from "@/lib/settings";

/**
 * Standard Solana wallet adapter. Phantom (and other Wallet Standard wallets) are
 * auto-detected; Solflare adapter is registered explicitly. No wallet emulation.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const { endpoint } = useSettings();
  const wallets = useMemo(() => (typeof window === "undefined" ? [] : [new SolflareWalletAdapter()]), []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect localStorageKey="studio-loco:wallet">
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

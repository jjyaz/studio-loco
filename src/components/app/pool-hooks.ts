import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { getPool, invalidatePool, poolFunctionType } from "@/lib/dlmm";
import { getMintBalance } from "@/lib/chain";
import { useSettings } from "@/lib/settings";
import { uiPriceFromBin } from "@/lib/bins";
import type { RailBin } from "./RailMap";

export function usePoolSdk(address: string, opts: { cluster?: string } = {}) {
  const { connection } = useConnection();
  const { settings } = useSettings();
  return useQuery({
    queryKey: ["dlmm", connection.rpcEndpoint, settings.cluster, address],
    queryFn: async () => {
      invalidatePool(address);
      const pool = await getPool(connection, address, settings.cluster);
      return pool;
    },
    // Suppress requests for empty/invalid addresses and for plans bound to another cluster.
    enabled: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && (!opts.cluster || opts.cluster === settings.cluster),
    retry: 1,
    staleTime: 20_000,
  });
}

export interface PoolSnapshot {
  activeId: number;
  binStep: number;
  decX: number;
  decY: number;
  mintX: string;
  mintY: string;
  reserveX: string;
  reserveY: string;
  functionType?: number;
  bins: RailBin[];
  activePrice: number;
  status: number;
}

export function usePoolSnapshot(address: string, radius = 40, opts: { cluster?: string } = {}) {
  const sdk = usePoolSdk(address, opts);
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["dlmm-snap", connection.rpcEndpoint, address, radius, sdk.dataUpdatedAt],
    enabled: !!sdk.data,
    queryFn: async (): Promise<PoolSnapshot> => {
      const pool = sdk.data!;
      await pool.refetchStates();
      const { activeBin, bins } = await pool.getBinsAroundActiveBin(radius, radius);
      const decX = pool.tokenX.mint.decimals;
      const decY = pool.tokenY.mint.decimals;
      return {
        activeId: activeBin,
        binStep: pool.lbPair.binStep,
        decX,
        decY,
        mintX: pool.tokenX.publicKey.toBase58(),
        mintY: pool.tokenY.publicKey.toBase58(),
        reserveX: pool.tokenX.amount.toString(),
        reserveY: pool.tokenY.amount.toString(),
        functionType: poolFunctionType(pool),
        status: pool.lbPair.status,
        bins: bins.map((b) => ({ binId: b.binId, xAmount: b.xAmount.toString(), yAmount: b.yAmount.toString(), price: Number(b.pricePerToken) })),
        // pricePerToken from the SDK is already decimal-adjusted (Y per X). If the active bin
        // isn't in the returned set, derive from the bin id with both decimals — never pass a bin id as a price.
        activePrice: (() => { const b = bins.find((x) => x.binId === activeBin); return b ? Number(b.pricePerToken) : uiPriceFromBin(activeBin, pool.lbPair.binStep, decX, decY); })(),
      };
    },
    refetchInterval: 30_000,
    retry: 1,
  });
}

export function useBalance(owner: PublicKey | null, mint: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["bal", connection.rpcEndpoint, owner?.toBase58(), mint],
    enabled: !!owner && !!mint,
    queryFn: () => getMintBalance(connection, owner!, mint!),
    refetchInterval: 30_000,
    retry: 1,
  });
}

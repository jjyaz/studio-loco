import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { loadSdk } from "@/lib/dlmm";
import { useSettings } from "@/lib/settings";
import type { LbPosition } from "@meteora-ag/dlmm";

export interface PositionRow {
  pair: string;
  position: LbPosition;
  key: string;
  activeId: number;
  binStep: number;
  mintX: string;
  mintY: string;
  decX: number;
  decY: number;
  lower: number;
  upper: number;
}

/** Real DLMM positions for the connected wallet. Requires an RPC that allows getProgramAccounts. */
export function usePositions(refetchMs: number | false = false) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { settings } = useSettings();
  return useQuery({
    queryKey: ["positions", connection.rpcEndpoint, settings.cluster, publicKey?.toBase58()],
    enabled: !!publicKey,
    refetchInterval: refetchMs,
    retry: 1,
    queryFn: async (): Promise<PositionRow[]> => {
      const sdk = await loadSdk();
      const map = await sdk.default.getAllLbPairPositionsByUser(connection, publicKey!, { cluster: settings.cluster });
      const rows: PositionRow[] = [];
      for (const [pair, info] of map) {
        const lb = info.lbPair as unknown as { activeId: number; binStep: number };
        for (const p of info.lbPairPositionsData) {
          rows.push({
            pair,
            position: p,
            key: p.publicKey.toBase58(),
            activeId: lb.activeId,
            binStep: lb.binStep,
            mintX: info.tokenX.publicKey.toBase58(),
            mintY: info.tokenY.publicKey.toBase58(),
            decX: info.tokenX.mint.decimals,
            decY: info.tokenY.mint.decimals,
            lower: p.positionData.lowerBinId,
            upper: p.positionData.upperBinId,
          });
        }
      }
      return rows;
    },
  });
}

export type RangeState = "in-range" | "approaching-edge" | "out-of-range";
export function rangeState(activeId: number, lower: number, upper: number, buffer: number): RangeState {
  if (activeId < lower || activeId > upper) return "out-of-range";
  if (activeId - lower < buffer || upper - activeId < buffer) return "approaching-edge";
  return "in-range";
}

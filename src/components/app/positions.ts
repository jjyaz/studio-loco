import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { loadSdk } from "@/lib/dlmm";
import { useSettings } from "@/lib/settings";
import type { LbPosition } from "@meteora-ag/dlmm";
import type { Connection, PublicKey } from "@solana/web3.js";
import { fetchIndexedPortfolio } from "@/lib/meteora-api";
import { DLMM_PROGRAM_ID, getPool } from "@/lib/dlmm";

/** Position account layout prefix: 8-byte discriminator, lb_pair (32), owner (32). */
export function readPositionHeader(data: Uint8Array): { lbPair: Uint8Array; owner: Uint8Array } | null {
  if (data.length < 72) return null;
  return { lbPair: data.slice(8, 40), owner: data.slice(40, 72) };
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Mainnet: discover via Meteora's indexed portfolio API, then hydrate each position by address
 * with the SDK (getPosition) and VERIFY on chain that the account belongs to the DLMM program,
 * the claimed pool and this owner. Anything that fails verification is dropped and reported.
 */
export async function hydrateIndexedPositions(connection: Connection, owner: PublicKey, signal?: AbortSignal): Promise<{ rows: PositionRow[]; rejected: number; indexedAt: number }> {
  const { PublicKey } = await import("@solana/web3.js");
  const idx = await fetchIndexedPortfolio(owner.toBase58(), signal);
  const rows: PositionRow[] = [];
  let rejected = 0;
  for (const ip of idx.pools) {
    const pool = await getPool(connection, ip.poolAddress, "mainnet-beta");
    const poolKey = pool.pubkey.toBytes();
    const keys = ip.listPositions.map((k) => new PublicKey(k));
    const infos = keys.length ? await connection.getMultipleAccountsInfo(keys, "confirmed") : [];
    for (let i = 0; i < keys.length; i++) {
      const acc = infos[i];
      const h = acc && acc.owner.toBase58() === DLMM_PROGRAM_ID ? readPositionHeader(new Uint8Array(acc.data)) : null;
      if (!h || !eq(h.lbPair, poolKey) || !eq(h.owner, owner.toBytes())) { rejected++; continue; }
      const pos = await pool.getPosition(keys[i]!);
      rows.push({
        pair: ip.poolAddress, position: pos, key: keys[i]!.toBase58(),
        activeId: pool.lbPair.activeId, binStep: pool.lbPair.binStep,
        mintX: pool.tokenX.publicKey.toBase58(), mintY: pool.tokenY.publicKey.toBase58(),
        decX: pool.tokenX.mint.decimals, decY: pool.tokenY.mint.decimals,
        lower: pos.positionData.lowerBinId, upper: pos.positionData.upperBinId,
      });
    }
  }
  return { rows, rejected, indexedAt: idx.fetchedAt };
}

/** Read-only indexed readings for any address (watch-only). Mainnet index; never used for tx amounts. */
export function useIndexedPortfolio(address: string | null) {
  return useQuery({
    queryKey: ["indexed-portfolio", "mainnet-beta", address],
    enabled: !!address,
    retry: 1,
    staleTime: 30_000,
    queryFn: ({ signal }) => fetchIndexedPortfolio(address!, signal),
  });
}

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
    queryFn: async ({ signal }): Promise<PositionRow[]> => {
      if (settings.cluster === "mainnet-beta") {
        const r = await hydrateIndexedPositions(connection, publicKey!, signal);
        return r.rows;
      }
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

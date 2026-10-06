import type { Connection, PublicKey } from "@solana/web3.js";
import type DLMMType from "@meteora-ag/dlmm";
import type { ParsedLimitOrderWithPubkey } from "@meteora-ag/dlmm";
import { loadSdk, DLMM_PROGRAM_ID } from "@/lib/dlmm";
import { fetchIndexedOpenOrders } from "@/lib/meteora-api";
import { verifyDlmmAccount, chunk } from "@/lib/account-verify";

export type OrderRows = ParsedLimitOrderWithPubkey[] & {
  report: { source: "index" | "scan"; rejected: number; truncated: boolean; indexedTotal?: number };
};

/**
 * Mainnet on the default relay: discover via Meteora's indexed open-orders endpoint, verify each
 * address on chain (program, LimitOrder discriminator, pool, owner), then read it through the SDK
 * (getLimitOrder) — chain data only feeds transactions. Devnet or a custom RPC: SDK program scan.
 */
export async function discoverOrders(
  pool: DLMMType, connection: Connection, owner: PublicKey,
  mode: { cluster: string; customRpc: boolean }, signal?: AbortSignal,
): Promise<OrderRows> {
  if (mode.cluster !== "mainnet-beta" || mode.customRpc) {
    const rows = await pool.getLimitOrderByUserAndLbPair(owner);
    return Object.assign(rows, { report: { source: "scan" as const, rejected: 0, truncated: false } });
  }
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await loadSdk();
  const disc = Uint8Array.from(sdk.getAccountDiscriminator("limitOrder"));
  const idx = await fetchIndexedOpenOrders(owner.toBase58(), pool.pubkey.toBase58(), signal);
  const keys = idx.addresses.map((a) => new PublicKey(a));
  const rows: ParsedLimitOrderWithPubkey[] = [];
  let rejected = idx.dropped;
  for (const part of chunk(keys, 100)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const infos = await connection.getMultipleAccountsInfo(part, "confirmed");
    for (let i = 0; i < part.length; i++) {
      if (!verifyDlmmAccount(infos[i], { programId: DLMM_PROGRAM_ID, discriminator: disc, lbPair: pool.pubkey.toBytes(), owner: owner.toBytes() })) { rejected++; continue; }
      rows.push(await pool.getLimitOrder(part[i]!));
    }
  }
  return Object.assign(rows, { report: { source: "index" as const, rejected, truncated: idx.truncated, indexedTotal: idx.total } });
}

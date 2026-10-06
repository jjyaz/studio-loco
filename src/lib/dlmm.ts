import "./polyfills";
import type { Connection, PublicKey } from "@solana/web3.js";
import type DLMMType from "@meteora-ag/dlmm";
import type { Cluster } from "./settings";

/** Lazily load the official Meteora DLMM SDK (heavy) only when a chain feature needs it. */
let sdkPromise: Promise<typeof import("@meteora-ag/dlmm")> | null = null;
export function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@meteora-ag/dlmm");
  return sdkPromise;
}

export type DLMM = DLMMType;

export const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const cache = new Map<string, Promise<DLMMType>>();

export async function getPool(connection: Connection, address: PublicKey | string, cluster: Cluster): Promise<DLMMType> {
  const { PublicKey } = await import("@solana/web3.js");
  const key = `${connection.rpcEndpoint}|${cluster}|${address.toString()}`;
  let p = cache.get(key);
  if (!p) {
    p = loadSdk().then((m) => m.default.create(connection, new PublicKey(address.toString()), { cluster }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  const pool = await p;
  return pool;
}

export function invalidatePool(address: string) {
  for (const k of cache.keys()) if (k.endsWith(`|${address}`)) cache.delete(k);
}

/** functionType: 0 undetermined, 1 liquidity mining, 2 limit order */
export function poolFunctionType(pool: DLMMType): number | undefined {
  const params = pool.lbPair.parameters as unknown as { functionType?: number };
  return typeof params?.functionType === "number" ? params.functionType : undefined;
}

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

/**
 * Pool function mode from lbPair.parameters.functionType (FunctionType enum:
 * 0 Undetermined, 1 LiquidityMining, 2 LimitOrder). This is NOT ConcreteFunctionType,
 * which only exists on PresetParameter2 (0 LimitOrder, 1 LiquidityMining).
 */
export function poolFunctionType(pool: DLMMType): number {
  return pool.lbPair.parameters.functionType;
}

/** Uses the SDK's own isSupportLimitOrder (Undetermined pools qualify only with no reward mints). */
export async function poolSupportsLimitOrders(pool: DLMMType): Promise<{ ok: boolean; reason: string }> {
  const sdk = await loadSdk();
  try {
    const ok = sdk.isSupportLimitOrder(pool.lbPair);
    const ft = poolFunctionType(pool);
    if (ok) return { ok, reason: ft === 2 ? "Pool is in Limit Order mode." : "Pool mode is Undetermined with no liquidity-mining rewards, which the program treats as limit-order capable." };
    return { ok, reason: ft === 1 ? "Pool is in Liquidity Mining mode; the program rejects native limit orders here." : "Pool has liquidity-mining reward mints configured, so native limit orders are unavailable." };
  } catch {
    return { ok: false, reason: "Unrecognised function mode — orders disabled." };
  }
}

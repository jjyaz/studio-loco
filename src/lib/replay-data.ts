import { fetchJson, fetchPool, METEORA_API } from "./meteora-api";
import { isPublicKey } from "./strategy";
import { parseReplayCandles, replayWindow, type ReplayTape } from "./replay";
import type { VolFrame } from "./agents";

export async function fetchReplayTape(
  address: string,
  frame: VolFrame,
  bars: number,
  signal: AbortSignal,
): Promise<ReplayTape> {
  if (!isPublicKey(address)) throw new Error("Enter a valid 32-byte pool address.");
  const window = replayWindow(frame, bars);
  const pool = await fetchPool(address, signal);
  if (pool.address !== address || pool.is_blacklisted)
    throw new Error("Pool identity does not match, or the pool is blacklisted.");
  const binStep = pool.pool_config?.bin_step,
    decimalsX = pool.token_x.decimals,
    decimalsY = pool.token_y.decimals;
  if (
    !Number.isInteger(binStep) ||
    binStep! < 1 ||
    binStep! > 500 ||
    decimalsX === undefined ||
    decimalsY === undefined
  )
    throw new Error(
      "Pool bin step or token decimals are unavailable. Replay cannot infer its bin geometry.",
    );
  const url = `${METEORA_API}/pools/${encodeURIComponent(address)}/ohlcv?timeframe=${frame}&start_time=${window.startSec}&end_time=${window.endSec}`;
  const raw = await fetchJson<unknown>(url, { signal, retries: 1 });
  if (signal.aborted) throw new Error("Replay loading cancelled.");
  return {
    v: 1,
    source: "historical",
    pool: {
      address,
      name: pool.name ?? "DLMM pool",
      binStep: binStep!,
      decimalsX,
      decimalsY,
      symbolX: pool.token_x.symbol ?? "X",
      symbolY: pool.token_y.symbol ?? "Y",
    },
    frame,
    ...window,
    loadedAt: Date.now(),
    ...parseReplayCandles(raw, frame, window.startSec, window.endSec),
  };
}

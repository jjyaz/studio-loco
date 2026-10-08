import { ApiError, fetchJson, fetchPool, METEORA_API } from "./meteora-api";
import { isPublicKey } from "./strategy";
import { parseReplayCandles, replayWindow, type ReplayTape } from "./replay";
import { FRAME_MS, type VolFrame } from "./agents";

// Live API QA accepts 96 periods (8h at 5m; 4d at 1h). Full 24h/7d requests
// are rejected as "time range too large". Fetch bounded windows sequentially.
export const REPLAY_REQUEST_BARS = 96;
export const REPLAY_LOAD_TIMEOUT_MS = 40_000;

export async function fetchReplayTape(
  address: string,
  frame: VolFrame,
  bars: number,
  signal: AbortSignal,
): Promise<ReplayTape> {
  if (!isPublicKey(address)) throw new Error("Enter a valid 32-byte pool address.");
  if (signal.aborted) throw new ApiError("Replay loading cancelled", "aborted");
  const window = replayWindow(frame, bars);
  const bounded = new AbortController();
  const cancel = () => bounded.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, REPLAY_LOAD_TIMEOUT_MS);
  try {
    const pool = await fetchPool(address, bounded.signal);
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
    const step = FRAME_MS[frame] / 1000;
    const rows: {
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
    }[] = [];
    const requests: NonNullable<ReplayTape["requests"]>[number][] = [];
    for (
      let startSec = window.startSec;
      startSec < window.endSec;
      startSec += REPLAY_REQUEST_BARS * step
    ) {
      if (bounded.signal.aborted) throw new ApiError("Replay loading cancelled", "aborted");
      const endSec = Math.min(startSec + REPLAY_REQUEST_BARS * step, window.endSec);
      const url = `${METEORA_API}/pools/${encodeURIComponent(address)}/ohlcv?timeframe=${frame}&start_time=${startSec}&end_time=${endSec}`;
      const raw = await fetchJson<unknown>(url, {
        signal: bounded.signal,
        retries: 0,
        timeoutMs: 10_000,
      });
      // Half-open partitions exclude inclusive end_time rows before stitching.
      // Duplicate rows within a response still fail. Empty shards remain gaps.
      const shard = parseReplayCandles(raw, frame, startSec, endSec, 0);
      requests.push({
        startSec,
        endSec,
        rows: shard.candles.length,
        excludedOutside: shard.quality.excludedOutside,
      });
      rows.push(
        ...shard.candles.map((c) => ({
          timestamp: c.t,
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
        })),
      );
    }
    if (bounded.signal.aborted) throw new ApiError("Replay loading cancelled", "aborted");
    const parsed = parseReplayCandles({ data: rows }, frame, window.startSec, window.endSec);
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
      candles: parsed.candles,
      quality: {
        ...parsed.quality,
        excludedOutside: requests.reduce((n, r) => n + r.excludedOutside, 0),
      },
      requests,
    };
  } catch (e) {
    if (bounded.signal.aborted && !signal.aborted)
      throw new ApiError(
        "Historical tape loading timed out after 40s. Retry or choose another pool.",
        "timeout",
      );
    throw e;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

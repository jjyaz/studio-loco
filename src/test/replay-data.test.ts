// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchReplayTape, REPLAY_LOAD_TIMEOUT_MS } from "@/lib/replay-data";
import { ApiError } from "@/lib/meteora-api";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), candles: vi.fn() }));
vi.mock("@/lib/meteora-api", async (original) => ({
  ...(await original<typeof import("@/lib/meteora-api")>()),
  fetchPool: mocks.pool,
  fetchJson: mocks.candles,
}));
const address = "So11111111111111111111111111111111111111112";
function chunk(url: string) {
  const params = new URL(url).searchParams;
  const start = Number(params.get("start_time")),
    end = Number(params.get("end_time"));
  const step = params.get("timeframe") === "5m" ? 300 : 3600;
  // Inclusive end_time reproduces the API boundary that must be partitioned.
  const data = Array.from({ length: (end - start) / step + 1 }, (_, i) => ({
    timestamp: start + i * step,
    open: 1,
    high: 1.2,
    low: 0.8,
    close: 1.05,
    volume: 10,
  }));
  return { data };
}
beforeEach(() => {
  mocks.pool
    .mockReset()
    .mockResolvedValue({
      address,
      name: "Pool",
      token_x: { decimals: 6 },
      token_y: { decimals: 6 },
      pool_config: { bin_step: 25 },
    });
  mocks.candles.mockReset().mockImplementation(async (url: string) => chunk(url));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded historical tape loading", () => {
  it.each([
    { frame: "5m" as const, bars: 288, requests: 3 },
    { frame: "1h" as const, bars: 168, requests: 2 },
  ])(
    "stitches $bars $frame bars without double-counting inclusive boundaries",
    async ({ frame, bars, requests }) => {
      const tape = await fetchReplayTape(address, frame, bars, new AbortController().signal);
      expect(tape.candles).toHaveLength(bars);
      expect(new Set(tape.candles.map((c) => c.t)).size).toBe(bars);
      expect(tape.quality).toMatchObject({
        expectedBars: bars,
        missingBars: 0,
        gaps: 0,
        excludedOutside: requests,
      });
      expect(mocks.candles).toHaveBeenCalledTimes(requests);
      for (const request of tape.requests!)
        expect(
          (request.endSec - request.startSec) / (frame === "5m" ? 300 : 3600),
        ).toBeLessThanOrEqual(96);
      expect(tape.candles.at(-1)!.t).toBeLessThan(tape.endSec);
    },
  );
  it("keeps an empty early shard as missing history for a newer pool", async () => {
    mocks.candles.mockResolvedValueOnce({ data: [] });
    const tape = await fetchReplayTape(address, "5m", 288, new AbortController().signal);
    expect(tape.candles).toHaveLength(192);
    expect(tape.quality.missingBars).toBe(96);
    expect(tape.candles[0]!.t).toBe(tape.startSec + 96 * 300);
  });
  it("still refuses duplicates inside an individual response", async () => {
    mocks.candles.mockImplementationOnce(async (url: string) => {
      const raw = chunk(url);
      raw.data.push(raw.data[0]!);
      return raw;
    });
    await expect(fetchReplayTape(address, "5m", 288, new AbortController().signal)).rejects.toThrow(
      /Duplicate/,
    );
    expect(mocks.candles).toHaveBeenCalledOnce();
  });
  it("fails the whole tape when a later shard fails instead of returning partial success", async () => {
    mocks.candles
      .mockImplementationOnce(async (url: string) => chunk(url))
      .mockRejectedValueOnce(new ApiError("HTTP 503", "http", 503));
    await expect(fetchReplayTape(address, "5m", 288, new AbortController().signal)).rejects.toThrow(
      /503/,
    );
    expect(mocks.candles).toHaveBeenCalledTimes(2);
  });
  it("caller cancellation stops before requesting another shard", async () => {
    const caller = new AbortController();
    mocks.candles.mockImplementationOnce(async (url: string) => {
      caller.abort();
      return chunk(url);
    });
    await expect(fetchReplayTape(address, "5m", 288, caller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(mocks.candles).toHaveBeenCalledOnce();
  });
  it("bounds the whole load and distinguishes a deadline from user cancellation", async () => {
    vi.useFakeTimers();
    mocks.pool.mockImplementation(
      (_address: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new ApiError("Cancelled", "aborted")), {
            once: true,
          }),
        ),
    );
    const work = fetchReplayTape(address, "5m", 288, new AbortController().signal);
    const assertion = expect(work).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringMatching(/40s/),
    });
    await vi.advanceTimersByTimeAsync(REPLAY_LOAD_TIMEOUT_MS);
    await assertion;
    expect(mocks.candles).not.toHaveBeenCalled();
  });
});

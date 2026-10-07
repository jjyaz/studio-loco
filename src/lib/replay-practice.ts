import { uiPriceFromBin } from "./bins";
import { parseReplayCandles, type ReplayTape } from "./replay";

/** Explicit deterministic fixture. Never a fallback for historical API errors. */
export function practiceReplayTape(): ReplayTape {
  const startSec = 1_791_244_800; // fixed, reproducible completed 5m periods
  const bins = Array.from({ length: 96 }, (_, i) =>
    i < 20
      ? Math.round(Math.sin(i / 4) * 5)
      : i < 44
        ? Math.round((i - 20) * 1.5)
        : i < 70
          ? 36 - Math.round((i - 44) * 2.8)
          : -37 + Math.round((i - 70) * 2),
  );
  const price = (bin: number) => uiPriceFromBin(bin, 25, 6, 6);
  const raw = {
    data: bins
      .filter((_, i) => i !== 57 && i !== 58)
      .map((id, i) => {
        // Preserve the two missing periods rather than compressing the tape.
        const original = i < 57 ? i : i + 2;
        const prev = bins[Math.max(0, original - 1)]!;
        return {
          timestamp: startSec + original * 300,
          open: price(prev),
          high: price(Math.max(prev, id) + 3),
          low: price(Math.min(prev, id) - 3),
          close: price(id + 0.15),
          volume: null,
        };
      }),
  };
  const endSec = startSec + 96 * 300;
  return {
    v: 1,
    source: "practice",
    pool: {
      address: "PRACTICE-REPLAY",
      name: "Practice · Switchback Valley",
      binStep: 25,
      decimalsX: 6,
      decimalsY: 6,
      symbolX: "TEST-X",
      symbolY: "TEST-Y",
    },
    frame: "5m",
    startSec,
    endSec,
    loadedAt: 1_791_273_600_000,
    ...parseReplayCandles(raw, "5m", startSec, endSec),
  };
}

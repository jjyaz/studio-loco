/**
 * DLMM bin <-> price math, used for display and range selection only.
 * Price per lamport of bin i = (1 + binStep/10_000)^i.
 * UI price (Y per X) = pricePerLamport * 10^(decX - decY).
 * Transactions always use integer bin ids — floating point here only affects labels.
 */
export function pricePerLamportFromBin(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

export function uiPriceFromBin(binId: number, binStep: number, decX: number, decY: number): number {
  return pricePerLamportFromBin(binId, binStep) * Math.pow(10, decX - decY);
}

export function binFromUiPrice(
  price: number,
  binStep: number,
  decX: number,
  decY: number,
  round: "floor" | "ceil" | "round" = "round",
): number {
  if (!(price > 0) || !Number.isFinite(price)) return NaN;
  const perLamport = price / Math.pow(10, decX - decY);
  const raw = Math.log(perLamport) / Math.log(1 + binStep / 10_000);
  return Math[round](raw);
}

/** Percentage distance between two bins. */
export function pctMoveBetweenBins(fromBin: number, toBin: number, binStep: number): number {
  return (Math.pow(1 + binStep / 10_000, toBin - fromBin) - 1) * 100;
}

/** Base fee pct from preset parameters (DLMM: baseFactor*binStep*10*10^power / 1e9). */
export function baseFeePct(baseFactor: number, binStep: number, baseFeePowerFactor = 0): number {
  return (baseFactor * binStep * 10 * Math.pow(10, baseFeePowerFactor)) / 1e7;
}

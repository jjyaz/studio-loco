import {
  allocateBlueprintUnits,
  parseBlueprint,
  type Blueprint,
} from "../../packages/sdk/src/blueprint";
import type { CostReview } from "./agents-chain";
export * from "../../packages/sdk/src/blueprint";

export const FOUNDRY_REVIEW_TTL = 20_000;
export type FoundryCurve = "uniform" | "curve" | "bid-ask";
export function normalizedWeights(weights: number[]): number[] {
  if (!weights.length || weights.some((x) => !Number.isFinite(x) || x < 0))
    throw new Error("Invalid weights");
  const sum = weights.reduce((n, x) => n + x, 0);
  if (!sum) throw new Error("At least one bin needs a positive weight");
  const scaled = weights.map((x) => (x / sum) * 10_000);
  const out = scaled.map(Math.floor);
  let left = 10_000 - out.reduce((n, x) => n + x, 0);
  for (const { i } of scaled
    .map((x, i) => ({ i, r: x - out[i]! }))
    .filter((x) => weights[x.i]! > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i)) {
    if (!left) break;
    out[i] = out[i]! + 1;
    left--;
  }
  return out;
}
export function foundryBins(radius: number, curve: FoundryCurve): Blueprint["liquidity"]["bins"] {
  if (!Number.isInteger(radius) || radius < 1 || radius > 34) throw new Error("Choose 3–69 bins");
  const offsets = Array.from({ length: radius * 2 + 1 }, (_, i) => i - radius);
  const weight = (n: number) =>
    curve === "curve"
      ? (radius + 1 - Math.abs(n)) ** 2
      : curve === "bid-ask"
        ? (Math.abs(n) + 1) ** 2
        : 1;
  const xs = normalizedWeights(offsets.map((n) => (n >= 0 ? weight(n) : 0)));
  const ys = normalizedWeights(offsets.map((n) => (n <= 0 ? weight(n) : 0)));
  return offsets.map((offset, i) => ({ offset, xBps: xs[i]!, yBps: ys[i]! }));
}
export function draftBlueprint(pool: {
  address: string;
  mintX: string;
  mintY: string;
  binStep: number;
}): Blueprint {
  return parseBlueprint({
    format: "studio-loco/blueprint",
    version: 1,
    id: "draft-blueprint",
    revision: 1,
    name: "My liquidity route",
    cluster: "mainnet-beta",
    protocol: "meteora-dlmm",
    pool: pool.address,
    mintX: pool.mintX,
    mintY: pool.mintY,
    binStep: pool.binStep,
    liquidity: { budgetX: "0", budgetY: "0", bins: foundryBins(10, "curve") },
    ladders: [],
    rules: {
      slippageBps: 50,
      maxNetworkFeeLamports: 100_000,
      maxTotalFeeBps: 100,
      maxActiveBinDrift: 0,
    },
    createdAt: Date.now(),
  });
}
export function sameBlueprintConfig(a: Blueprint, b: Blueprint): boolean {
  const strip = (x: Blueprint) =>
    JSON.stringify({ ...parseBlueprint(x), id: "compare-blueprint", revision: 1, createdAt: 1 });
  try {
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}
export interface FoundryIdentity {
  wallet: string;
  cluster: string;
  rpc: string;
  practice: boolean;
  digest: string;
  action: string;
  position: string;
}
export function foundryReviewReason(
  review: { identity: FoundryIdentity; epoch: number; preparedAt: number },
  current: FoundryIdentity,
  epoch: number,
  now = Date.now(),
): string | null {
  if (current.practice || current.cluster !== "mainnet-beta")
    return "Live Foundry actions require mainnet with practice mode off.";
  if (!current.wallet) return "Connect a signing wallet.";
  if (epoch !== review.epoch || JSON.stringify(current) !== JSON.stringify(review.identity))
    return "The wallet, connection, blueprint or action changed. Prepare a new review.";
  if (now < review.preparedAt || now - review.preparedAt > FOUNDRY_REVIEW_TTL)
    return "Review expired. Prepare a fresh simulation.";
  return null;
}
export function foundryCostRefusal(c: CostReview, maxFee: number): string | null {
  if (c.remaining)
    return "This action requires more than one transaction. Narrow the range before reviewing again.";
  if (c.sizes.length !== 1 || !Number.isFinite(c.sizes[0]) || c.sizes[0]! > 1232)
    return "The atomic transaction exceeds Solana's size limit. Use fewer bins or existing price-level accounts.";
  if (c.simErrors[0]) return `Native simulation refused the action: ${c.simErrors[0]}`;
  const known = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    !known(c.feeLamports) ||
    !known(c.requiredLamports) ||
    !known(c.walletLamports) ||
    !known(c.solOutLamports)
  )
    return "Complete network fee, rent and SOL requirements could not be verified.";
  if (c.feeLamports > maxFee) return "Network fee exceeds the blueprint's ceiling.";
  if (c.walletLamports < c.requiredLamports)
    return "The wallet cannot fund the simulated upfront SOL requirement.";
  return null;
}

/** SDK's Q64 quote-value conversion, with integer arithmetic and explicit 16-bit rounding. */
export function nativeFoundryWeights(
  bins: { binId: number; xRaw: string; yRaw: string }[],
  qPrice: (binId: number) => bigint,
) {
  const values = bins.map((b) => ({
    binId: b.binId,
    value: BigInt(b.yRaw) + ((BigInt(b.xRaw) * qPrice(b.binId)) >> 64n),
    funded: BigInt(b.xRaw) + BigInt(b.yRaw) > 0n,
  }));
  if (values.some((b) => b.funded && b.value === 0n))
    throw new Error(
      "A funded bin rounds below the native price precision. Increase its budget or remove its weight.",
    );
  const total = values.reduce((n, b) => n + b.value, 0n);
  if (!total) throw new Error("Add a non-zero liquidity budget.");
  const out = values.map((b) => ({ binId: b.binId, weight: Number((b.value * 65_535n) / total) }));
  if (out.some((b, i) => b.weight === 0 && values[i]!.funded))
    throw new Error(
      "A funded bin rounds to zero in the native 16-bit distribution. Adjust the allocation.",
    );
  // The program rejects zero native weights. Keep empty bins in the position range,
  // but send only funded bins in the deposit distribution.
  return out.filter((b) => b.weight > 0);
}

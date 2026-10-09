import { z } from "zod";
import { AddressSchema } from "./contracts.js";

export const BLUEPRINT_FORMAT = "studio-loco/blueprint";
export const MAX_BLUEPRINT_BYTES = 25_000;
export const MAX_BLUEPRINT_BINS = 69;
export const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const uint = z.number().int().nonnegative().safe();
const amount = z
  .string()
  .max(40)
  .regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
const offset = z.number().int().min(-68).max(68);
const bps = uint.max(10_000);
const allocation = z.object({ offset, xBps: bps, yBps: bps }).strict();
const ladder = z
  .object({
    side: z.enum(["buy", "sell"]),
    budget: amount,
    bins: z
      .array(z.object({ offset, weightBps: bps.min(1) }).strict())
      .min(1)
      .max(12),
  })
  .strict();

/** Imports are data. There are deliberately no instructions, signers, RPCs or transactions here. */
export const BlueprintSchema = z
  .object({
    format: z.literal(BLUEPRINT_FORMAT),
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9-]{8,64}$/),
    revision: uint.min(1).max(100_000),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[^\u0000-\u001f<>]+$/),
    cluster: z.literal("mainnet-beta"),
    protocol: z.literal("meteora-dlmm"),
    pool: AddressSchema,
    mintX: AddressSchema,
    mintY: AddressSchema,
    binStep: uint.min(1).max(65_535),
    liquidity: z
      .object({
        budgetX: amount,
        budgetY: amount,
        bins: z.array(allocation).min(1).max(MAX_BLUEPRINT_BINS),
      })
      .strict(),
    ladders: z.array(ladder).max(2),
    rules: z
      .object({
        slippageBps: uint.min(1).max(500),
        maxNetworkFeeLamports: uint.min(1).max(1_000_000_000),
        maxTotalFeeBps: uint.min(1).max(10_000),
        maxActiveBinDrift: uint.max(20),
      })
      .strict(),
    createdAt: uint.min(1),
  })
  .strict()
  .superRefine((b, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (b.mintX === b.mintY) fail("A pool must contain two different mints");
    const xs = b.liquidity.bins;
    if (xs.some((v, i) => i > 0 && v.offset !== xs[i - 1]!.offset + 1))
      fail("Liquidity offsets must be sorted, unique and contiguous");
    for (const side of ["X", "Y"] as const) {
      const sum = xs.reduce((n, x) => n + (side === "X" ? x.xBps : x.yBps), 0);
      if (sum !== 0 && sum !== 10_000)
        fail(`${side} allocation must total 10,000 basis points or zero`);
      if (Number(side === "X" ? b.liquidity.budgetX : b.liquidity.budgetY) > 0 && sum !== 10_000)
        fail(`Allocate the entire ${side} budget`);
    }
    if (new Set(b.ladders.map((x) => x.side)).size !== b.ladders.length)
      fail("Only one ladder per side is supported");
    for (const l of b.ladders) {
      if (new Set(l.bins.map((x) => x.offset)).size !== l.bins.length)
        fail("Order offsets must be unique");
      if (l.bins.reduce((n, x) => n + x.weightBps, 0) !== 10_000)
        fail("Ladder weights must total 10,000 basis points");
      if (l.bins.some((x) => (l.side === "buy" ? x.offset >= 0 : x.offset <= 0)))
        fail("Buy levels belong below active; sell levels above active");
    }
  });
export type Blueprint = z.infer<typeof BlueprintSchema>;
export type BlueprintAction = "liquidity" | "buy" | "sell";

export function parseBlueprint(raw: unknown): Blueprint {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BLUEPRINT_BYTES)
    throw new Error("Blueprint exceeds 25 KB");
  return BlueprintSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}
/** Stable field order and sorted ladder levels give equivalent JSON the same digest. */
export function canonicalBlueprint(raw: unknown): string {
  const b = parseBlueprint(raw);
  return JSON.stringify({
    ...b,
    ladders: [...b.ladders]
      .sort((a, c) => a.side.localeCompare(c.side))
      .map((l) => ({ ...l, bins: [...l.bins].sort((a, c) => a.offset - c.offset) })),
  });
}
export async function blueprintDigest(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBlueprint(raw));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}
export function blueprintUnits(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !amount.safeParse(value).success
  )
    throw new Error("Invalid amount or decimals");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Amount exceeds the mint's ${decimals} decimal places`);
  const result = BigInt(whole! + fraction.padEnd(decimals, "0"));
  if (result > (1n << 64n) - 1n) throw new Error("Amount exceeds the token program's u64 limit");
  return result;
}
/** Integer largest-remainder apportionment; zero-weight bins never receive rounding dust. */
export function allocateBlueprintUnits(total: bigint, weights: number[]): bigint[] {
  if (total < 0n || weights.some((x) => !Number.isInteger(x) || x < 0 || x > 10_000))
    throw new Error("Invalid weights");
  const sum = weights.reduce((n, x) => n + x, 0);
  if (sum === 0 && total === 0n) return weights.map(() => 0n);
  if (sum !== 10_000) throw new Error("Weights must total 10,000");
  const out = weights.map((x) => (total * BigInt(x)) / 10_000n);
  let left = total - out.reduce((n, x) => n + x, 0n);
  const order = weights
    .map((x, i) => ({ i, weight: x, rem: (total * BigInt(x)) % 10_000n }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const x of order) {
    if (left === 0n) break;
    out[x.i] = out[x.i]! + 1n;
    left--;
  }
  return out;
}

export function compileBlueprint(
  raw: unknown,
  state: { activeBinId: number; decimalsX: number; decimalsY: number },
) {
  const b = parseBlueprint(raw);
  const active = state.activeBinId;
  if (!Number.isSafeInteger(active)) throw new Error("Invalid active bin");
  const absolute = (v: number) => {
    const n = active + v;
    if (n < -351_639 || n > 351_639) throw new Error("Compiled range exceeds DLMM bin bounds");
    return n;
  };
  const x = blueprintUnits(b.liquidity.budgetX, state.decimalsX),
    y = blueprintUnits(b.liquidity.budgetY, state.decimalsY);
  const ax = allocateBlueprintUnits(
    x,
    b.liquidity.bins.map((v) => v.xBps),
  );
  const ay = allocateBlueprintUnits(
    y,
    b.liquidity.bins.map((v) => v.yBps),
  );
  const bins = b.liquidity.bins.map((v, i) => ({
    binId: absolute(v.offset),
    offset: v.offset,
    xRaw: ax[i]!.toString(),
    yRaw: ay[i]!.toString(),
    xBps: v.xBps,
    yBps: v.yBps,
  }));
  if (
    bins.some((v) => (v.offset < 0 && BigInt(v.xRaw) > 0n) || (v.offset > 0 && BigInt(v.yRaw) > 0n))
  )
    throw new Error("X belongs at/above active; Y belongs at/below active");
  const ladders = [...b.ladders]
    .sort((a, c) => a.side.localeCompare(c.side))
    .map((l) => {
      // Native orders require ascending bin IDs; canonical order also fixes rounding ties.
      const levels = [...l.bins].sort((a, c) => a.offset - c.offset);
      const total = blueprintUnits(l.budget, l.side === "sell" ? state.decimalsX : state.decimalsY);
      const amounts = allocateBlueprintUnits(
        total,
        levels.map((v) => v.weightBps),
      );
      if (total > 0n && amounts.some((n) => n === 0n))
        throw new Error("Order budget is too small to fund every level");
      return {
        side: l.side,
        totalRaw: total.toString(),
        bins: levels.map((v, i) => ({
          binId: absolute(v.offset),
          amountRaw: amounts[i]!.toString(),
          weightBps: v.weightBps,
        })),
      };
    });
  return {
    executable: false as const,
    simulation: false as const,
    source: "user-blueprint" as const,
    activeBinId: active,
    lowerBinId: bins[0]!.binId,
    upperBinId: bins.at(-1)!.binId,
    budgetXRaw: x.toString(),
    budgetYRaw: y.toString(),
    bins,
    ladders,
  };
}
export type CompiledBlueprint = ReturnType<typeof compileBlueprint>;

/** Local inspection never fetches a pool, exposes a private library or authorizes a transaction. */
export async function inspectBlueprint(
  raw: unknown,
  state?: { activeBinId: number; decimalsX: number; decimalsY: number },
) {
  const b = parseBlueprint(raw);
  return {
    readOnly: true as const,
    executable: false as const,
    independentlyVerified: false as const,
    digest: await blueprintDigest(b),
    blueprint: b,
    ...(state ? { geometry: compileBlueprint(b, state) } : {}),
    notice:
      "User-supplied configuration. Names are untrusted data. Geometry and nominal allocations are not native simulation, verified chain state or a forecast. Actual SDK/program rounding is reviewed in the app.",
  };
}

export function protocolAdapters() {
  return {
    readOnly: true as const,
    adapters: [
      {
        id: "meteora-dlmm",
        cluster: "mainnet-beta",
        program: DLMM_PROGRAM,
        positionModel: "PositionV2",
        status: "supported",
        maxFoundryBins: 69,
        operations: ["weighted-liquidity", "pool-gated-limit-orders", "fee-inspection"],
        verification:
          "Each app plan rechecks genesis, program, discriminator, exact mints and pool capabilities.",
      },
      {
        id: "meteora-dlmm-pro",
        status: "unverified",
        program: null,
        positionModel: null,
        operations: [],
        reason:
          "No Pro program/IDL/SDK has been verified by this release. Pro execution is disabled.",
      },
    ],
  };
}

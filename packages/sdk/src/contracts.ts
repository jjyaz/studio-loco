import { z } from "zod";

export const SDK_VERSION = "0.2.0";
export const API_VERSION = "1";
export const DEFAULT_BASE_URL = "https://studioloco.cfd/api/public/loco/v1";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Includes PDA addresses. Validates the decoded length, rather than only the characters. */
export function isAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
export const AddressSchema = z.string().refine(isAddress, "Expected a 32-byte Solana address");
const bin = z.number().int().min(-351639).max(351639);
const uint = z.number().int().nonnegative().safe();
const optionalMetric = z.number().finite().nonnegative().nullable();
export const SORT_KEYS = ["tvl", "volume_24h", "fee_24h", "fee_tvl_ratio_24h", "bin_step"] as const;
export const PoolQuerySchema = z
  .object({
    page: z.number().int().min(1).max(20).default(1),
    perPage: z.number().int().min(1).max(25).default(10),
    query: z.string().trim().max(80).optional(),
    sort: z.enum(SORT_KEYS).default("tvl"),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type PoolQuery = z.input<typeof PoolQuerySchema>;
export const MetaSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  sdkVersion: z.string().max(40),
  cluster: z.literal("mainnet-beta"),
  source: z.enum(["meteora-index", "solana-confirmed", "studio-loco"]),
  observedAt: z.number().int().positive().safe(),
  slot: uint.optional(),
  mintSlot: uint.optional(),
});
export type Snapshot<T> = { ok: true; data: T; meta: z.infer<typeof MetaSchema> };
const token = z.object({
  address: AddressSchema,
  symbol: z.string().max(80).nullable(),
  decimals: z.number().int().min(0).max(18).nullable(),
});
export const PoolSchema = z.object({
  address: AddressSchema,
  name: z.string().max(160),
  tokenX: token,
  tokenY: token,
  tvlUsd: optionalMetric,
  currentPrice: optionalMetric,
  volume24hUsd: optionalMetric,
  fees24hUsd: optionalMetric,
  binStep: z.number().int().min(1).max(65535).nullable(),
  blacklisted: z.boolean().nullable(),
});
export type Pool = z.infer<typeof PoolSchema>;
export const PoolListSchema = z.object({
  pools: z.array(PoolSchema).max(25),
  page: uint.min(1).max(20),
  perPage: uint.min(1).max(25),
  total: uint.nullable(),
  hasMore: z.boolean(),
  dropped: uint,
});
export const PositionSchema = z
  .object({
    address: AddressSchema,
    pool: AddressSchema,
    owner: AddressSchema,
    mintX: AddressSchema,
    mintY: AddressSchema,
    decimalsX: uint.max(18),
    decimalsY: uint.max(18),
    lowerBinId: bin,
    upperBinId: bin,
    activeBinId: bin,
    binStep: uint.min(1).max(65535),
    inRange: z.boolean(),
  })
  .refine(
    (p) =>
      p.lowerBinId <= p.upperBinId &&
      p.inRange === (p.activeBinId >= p.lowerBinId && p.activeBinId <= p.upperBinId),
    "Inconsistent position range",
  );
export type Position = z.infer<typeof PositionSchema>;
export const CapabilitiesSchema = z.object({
  name: z.literal("Studio Loco"),
  readOnly: z.literal(true),
  features: z.array(z.string().max(80)).max(20),
  limits: z.object({
    maxPage: z.literal(20),
    maxPerPage: z.literal(25),
    maxRangeBins: z.literal(69),
    timeoutMs: z.literal(15000),
  }),
  exclusions: z.array(z.string().max(160)).max(20),
});
export const ErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().max(80),
    message: z.string().max(400),
    retryable: z.boolean(),
  }),
});
export const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data, meta: MetaSchema });

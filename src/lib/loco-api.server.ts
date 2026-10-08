import { z } from "zod";
import { Buffer } from "buffer";
import {
  AddressSchema,
  API_VERSION,
  CapabilitiesSchema,
  MetaSchema,
  PoolListSchema,
  PoolQuerySchema,
  PoolSchema,
  PositionSchema,
  SDK_VERSION,
  type Snapshot,
} from "../../packages/sdk/src/contracts";
import { LocoError, readJsonLimited } from "../../packages/sdk/src/client";
import { buildPoolsUrl, METEORA_API, normalizePool, type ApiPool } from "./meteora-api";
import { loadSdk, DLMM_PROGRAM_ID } from "./dlmm";

const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const uint = z.number().int().nonnegative().safe();
export const LOCO_CAPABILITIES = CapabilitiesSchema.parse({
  name: "Studio Loco",
  readOnly: true,
  features: [
    "indexed-pool-list",
    "indexed-pool-detail",
    "confirmed-position-snapshot",
    "local-range-geometry",
    "local-recorder-export-analysis",
    "hosted-mcp",
    "stdio-mcp",
  ],
  limits: { maxPage: 20, maxPerPage: 25, maxRangeBins: 69, timeoutMs: 15000 },
  exclusions: [
    "Wallet signing or transaction submission",
    "Private cloud Recorder or Signal Box reads",
    "Executable quotes or profit forecasts",
    "DLMM Pro integration",
    "Devnet or user-provided RPC URLs",
  ],
});
const meta = (
  source: z.infer<typeof MetaSchema>["source"],
  extra: Partial<z.infer<typeof MetaSchema>> = {},
) =>
  MetaSchema.parse({
    apiVersion: API_VERSION,
    sdkVersion: SDK_VERSION,
    cluster: "mainnet-beta",
    source,
    observedAt: Date.now(),
    ...extra,
  });
const snapshot = <T>(
  data: T,
  source: z.infer<typeof MetaSchema>["source"],
  extra?: Partial<z.infer<typeof MetaSchema>>,
): Snapshot<T> => ({ ok: true, data, meta: meta(source, extra) });
let activeReads = 0;
/** Every server read has a complete headers/body/decode budget, including cancellation. */
export async function withLocoBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  budgetMs = 15000,
): Promise<T> {
  if (activeReads >= 8) throw new LocoError("busy", "Loco is busy. Retry shortly.", 429, true);
  activeReads++;
  const c = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      c.abort();
      reject(new LocoError("aborted", "Request cancelled", 408));
    };
    if (parent?.aborted) {
      cancel();
      return;
    }
    parent?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      c.abort();
      reject(new LocoError("upstream-timeout", "Data source timed out. Retry shortly.", 504, true));
    }, budgetMs);
  });
  try {
    return await Promise.race([
      c.signal.aborted
        ? Promise.reject(new LocoError("aborted", "Request cancelled", 408))
        : work(c.signal),
      stopped,
    ]);
  } catch (e) {
    if (e instanceof LocoError) throw e;
    if (e instanceof z.ZodError)
      throw new LocoError("invalid-upstream", "Live data failed format verification", 502, true);
    throw new LocoError(
      "upstream-unavailable",
      "Live data could not be verified. Retry shortly.",
      502,
      true,
    );
  } finally {
    c.abort();
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    activeReads--;
  }
}
async function upstream(url: string, signal: AbortSignal, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
      redirect: "error",
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch {
    throw new LocoError("upstream-network", "Live data source could not be reached", 502, true);
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new LocoError(
      response.status === 404 ? "not-found" : "upstream-unavailable",
      response.status === 404 ? "Pool not found" : "Live data source is unavailable",
      response.status === 404 ? 404 : 502,
      response.status !== 404,
    );
  }
  return readJsonLimited(response, 2_000_000, signal);
}
export function publicPool(raw: unknown) {
  const p = normalizePool(raw);
  if (!p) throw new LocoError("invalid-upstream", "Pool metadata could not be verified", 502, true);
  const token = (t: ApiPool["token_x"]) => ({
    address: t.address,
    symbol: t.symbol?.slice(0, 80) ?? null,
    decimals: t.decimals ?? null,
  });
  return PoolSchema.parse({
    address: p.address,
    name: (p.name ?? p.address).slice(0, 160),
    tokenX: token(p.token_x),
    tokenY: token(p.token_y),
    tvlUsd: p.tvl ?? null,
    currentPrice: p.current_price ?? null,
    volume24hUsd: p.volume?.["24h"] ?? null,
    fees24hUsd: p.fees?.["24h"] ?? null,
    binStep: p.pool_config?.bin_step ?? null,
    blacklisted: p.is_blacklisted ?? null,
  });
}
export async function readPools(input: unknown, parent?: AbortSignal) {
  const p = PoolQuerySchema.safeParse(input);
  if (!p.success)
    throw new LocoError("invalid-input", "Invalid query. Pages 1–20; 1–25 pools per page.", 400);
  return withLocoBudget(async (signal) => {
    const q = p.data;
    const raw = await upstream(
      buildPoolsUrl({
        page: q.page,
        pageSize: q.perPage,
        query: q.query,
        sort: q.sort,
        dir: q.direction,
      }),
      signal,
    );
    const page = z
      .object({
        data: z.array(z.unknown()).max(25),
        current_page: uint.min(1),
        page_size: uint.min(1).max(25),
        pages: uint,
        total: uint,
      })
      .parse(raw);
    if (page.current_page !== q.page || page.page_size !== q.perPage)
      throw new LocoError("invalid-upstream", "Pool pagination could not be verified", 502);
    const pools: z.infer<typeof PoolSchema>[] = [];
    let dropped = 0;
    for (const r of page.data) {
      try {
        pools.push(publicPool(r));
      } catch {
        dropped++;
      }
    }
    return snapshot(
      PoolListSchema.parse({
        pools,
        page: q.page,
        perPage: q.perPage,
        total: page.total,
        hasMore: q.page < page.pages,
        dropped,
      }),
      "meteora-index",
    );
  }, parent);
}
export async function readPool(address: string, parent?: AbortSignal) {
  if (!AddressSchema.safeParse(address).success)
    throw new LocoError("invalid-input", "Invalid pool address", 400);
  return withLocoBudget(async (signal) => {
    const pool = publicPool(await upstream(`${METEORA_API}/pools/${address}`, signal));
    if (pool.address !== address)
      throw new LocoError("invalid-upstream", "Pool identity mismatch", 502);
    return snapshot(pool, "meteora-index");
  }, parent);
}
const AccountSchema = z
  .object({
    owner: AddressSchema,
    executable: z.literal(false),
    data: z.tuple([
      z
        .string()
        .max(1_500_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      z.literal("base64"),
    ]),
  })
  .nullable();
export function verifiedAccount(
  raw: z.infer<typeof AccountSchema>,
  program: string,
  discriminator?: Uint8Array,
) {
  if (!raw || raw.owner !== program)
    throw new LocoError(
      "verification-failed",
      "Account program or type could not be verified",
      422,
    );
  const data = Buffer.from(raw.data[0], "base64");
  if (discriminator && !data.subarray(0, 8).equals(Buffer.from(discriminator)))
    throw new LocoError("verification-failed", "Account discriminator mismatch", 422);
  return data;
}
export async function readPosition(address: string, pool: string, parent?: AbortSignal) {
  if (![address, pool].every((a) => AddressSchema.safeParse(a).success))
    throw new LocoError("invalid-input", "Valid position and pool addresses are required", 400);
  return withLocoBudget(async (signal) => {
    const rpc = process.env["SOLANA_MAINNET_RPC_URL"] || "https://solana-rpc.publicnode.com";
    const call = async (
      method: "getGenesisHash" | "getMultipleAccounts",
      params: unknown[] = [],
    ) => {
      const body = await upstream(rpc, signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const p = z
        .object({
          jsonrpc: z.literal("2.0"),
          id: z.literal(1),
          result: z.unknown(),
          error: z.unknown().optional(),
        })
        .parse(body);
      if (p.error)
        throw new LocoError(
          "upstream-unavailable",
          "Confirmed chain read is unavailable",
          502,
          true,
        );
      return p.result;
    };
    if ((await call("getGenesisHash")) !== GENESIS)
      throw new LocoError("verification-failed", "Mainnet genesis verification failed", 422);
    const sdk = await loadSdk();
    const { Program } = await import("@coral-xyz/anchor");
    const { Connection } = await import("@solana/web3.js");
    // The coder only needs a connection-shaped read provider; no RPC is issued by construction.
    const program = new Program(
      sdk.IDL as import("@coral-xyz/anchor").Idl,
      { connection: new Connection(rpc) } as import("@coral-xyz/anchor").AnchorProvider,
    );
    const Accounts = z.object({ context: z.object({ slot: uint }), value: z.array(AccountSchema) });
    const raw = Accounts.parse(
      await call("getMultipleAccounts", [
        [pool, address],
        { encoding: "base64", commitment: "confirmed" },
      ]),
    );
    if (raw.value.length !== 2)
      throw new LocoError("invalid-upstream", "Incomplete account snapshot", 502);
    const pairData = verifiedAccount(
      raw.value[0]!,
      DLMM_PROGRAM_ID,
      Uint8Array.from(sdk.getAccountDiscriminator("lbPair")),
    );
    const positionData = verifiedAccount(
      raw.value[1]!,
      DLMM_PROGRAM_ID,
      Uint8Array.from(sdk.getAccountDiscriminator("positionV2")),
    );
    const pair = program.coder.accounts.decode("lbPair", pairData) as {
      tokenXMint: { toBase58(): string };
      tokenYMint: { toBase58(): string };
      activeId: number;
      binStep: number;
    };
    const pos = program.coder.accounts.decode("positionV2", positionData) as {
      lbPair: { toBase58(): string };
      owner: { toBase58(): string };
      lowerBinId: number;
      upperBinId: number;
    };
    if (pos.lbPair.toBase58() !== pool)
      throw new LocoError("verification-failed", "Position belongs to another pool", 422);
    const mintX = pair.tokenXMint.toBase58(),
      mintY = pair.tokenYMint.toBase58();
    const mints = Accounts.parse(
      await call("getMultipleAccounts", [
        [mintX, mintY],
        { encoding: "base64", commitment: "confirmed", minContextSlot: raw.context.slot },
      ]),
    );
    if (mints.value.length !== 2 || mints.context.slot < raw.context.slot)
      throw new LocoError("verification-failed", "Mint snapshot is incomplete or stale", 422);
    const decimals = mints.value.map((a) => {
      if (!a || !TOKEN_PROGRAMS.has(a.owner))
        throw new LocoError("verification-failed", "Unsupported mint program", 422);
      const data = verifiedAccount(a, a.owner);
      if (data.length < 82 || data[45] !== 1 || data[44]! > 18)
        throw new LocoError("verification-failed", "Mint initialization or decimals mismatch", 422);
      return data[44]!;
    });
    const data = PositionSchema.parse({
      address,
      pool,
      owner: pos.owner.toBase58(),
      mintX,
      mintY,
      decimalsX: decimals[0],
      decimalsY: decimals[1],
      lowerBinId: pos.lowerBinId,
      upperBinId: pos.upperBinId,
      activeBinId: pair.activeId,
      binStep: pair.binStep,
      inRange: pair.activeId >= pos.lowerBinId && pair.activeId <= pos.upperBinId,
    });
    return snapshot(data, "solana-confirmed", {
      slot: raw.context.slot,
      mintSlot: mints.context.slot,
    });
  }, parent);
}
export const publicReaders = (signal?: AbortSignal) => ({
  capabilities: async () => snapshot(LOCO_CAPABILITIES, "studio-loco"),
  listPools: (q: Parameters<typeof readPools>[0] = {}) => readPools(q, signal),
  getPool: (a: string) => readPool(a, signal),
  getPosition: (a: string, p: string) => readPosition(a, p, signal),
});

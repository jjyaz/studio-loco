const address = {
  type: "string",
  pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$",
  description: "Base58 encoded 32-byte Solana address",
};
const nullableMetric = { type: ["number", "null"], minimum: 0 };
const uint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bin = { type: "integer", minimum: -351639, maximum: 351639 };
const token = {
  type: "object",
  required: ["address", "symbol", "decimals"],
  properties: {
    address,
    symbol: { type: ["string", "null"], maxLength: 80 },
    decimals: { type: ["integer", "null"], minimum: 0, maximum: 18 },
  },
};
const envelope = (name: string) => ({
  type: "object",
  required: ["ok", "data", "meta"],
  properties: {
    ok: { const: true },
    data: { $ref: `#/components/schemas/${name}` },
    meta: { $ref: "#/components/schemas/Meta" },
  },
});
const errorResponse = {
  description: "Typed error; no fixture fallback",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const response = (name: string) => ({
  "200": {
    description: "Observed mainnet data with provenance",
    content: { "application/json": { schema: envelope(name) } },
  },
  "400": errorResponse,
  "404": errorResponse,
  "422": errorResponse,
  "429": errorResponse,
  "502": errorResponse,
  "504": errorResponse,
});
const parameter = (name: string, schema: object, required = false, location = "query") => ({
  name,
  in: location,
  required,
  schema,
});
export const LOCO_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Studio Loco Read-only API",
    version: "1.0.0",
    description:
      "Mainnet Meteora DLMM reads. No signing, transaction submission, private Recorder access or DLMM Pro. All timestamps are Unix milliseconds. Null metrics mean unavailable. Indexed metrics are not chain-verifiable executable quotes.",
  },
  servers: [{ url: "https://studioloco.cfd/api/public/loco/v1" }],
  paths: {
    "/capabilities": {
      get: {
        operationId: "capabilities",
        summary: "Feature truth and request limits",
        responses: response("Capabilities"),
      },
    },
    "/pools": {
      get: {
        operationId: "listPools",
        summary: "Meteora indexed pools (bounded pagination)",
        parameters: [
          parameter("page", { type: "integer", minimum: 1, maximum: 20, default: 1 }),
          parameter("perPage", { type: "integer", minimum: 1, maximum: 25, default: 10 }),
          parameter("query", { type: "string", maxLength: 80 }),
          parameter("sort", {
            type: "string",
            enum: ["tvl", "volume_24h", "fee_24h", "fee_tvl_ratio_24h", "bin_step"],
            default: "tvl",
          }),
          parameter("direction", { type: "string", enum: ["asc", "desc"], default: "desc" }),
        ],
        responses: response("PoolList"),
      },
    },
    "/pools/{address}": {
      get: {
        operationId: "getPool",
        summary: "Indexed metadata for one pool",
        parameters: [parameter("address", address, true, "path")],
        responses: response("Pool"),
      },
    },
    "/positions/{address}": {
      get: {
        operationId: "getPosition",
        summary: "Confirmed PositionV2/pool snapshot with mint validation",
        parameters: [parameter("address", address, true, "path"), parameter("pool", address, true)],
        responses: response("Position"),
      },
    },
  },
  components: {
    schemas: {
      Meta: {
        type: "object",
        required: ["apiVersion", "sdkVersion", "cluster", "source", "observedAt"],
        properties: {
          apiVersion: { const: "1" },
          sdkVersion: { type: "string" },
          cluster: { const: "mainnet-beta" },
          source: { enum: ["meteora-index", "solana-confirmed", "studio-loco"] },
          observedAt: { ...uint, minimum: 1 },
          slot: uint,
          mintSlot: uint,
        },
      },
      Error: {
        type: "object",
        required: ["ok", "error"],
        properties: {
          ok: { const: false },
          error: {
            type: "object",
            required: ["code", "message", "retryable"],
            properties: {
              code: { type: "string" },
              message: { type: "string", maxLength: 400 },
              retryable: { type: "boolean" },
            },
          },
        },
      },
      Pool: {
        type: "object",
        required: [
          "address",
          "name",
          "tokenX",
          "tokenY",
          "tvlUsd",
          "currentPrice",
          "volume24hUsd",
          "fees24hUsd",
          "binStep",
          "blacklisted",
        ],
        properties: {
          address,
          name: { type: "string", maxLength: 160 },
          tokenX: token,
          tokenY: token,
          tvlUsd: nullableMetric,
          currentPrice: {
            ...nullableMetric,
            description: "Indexed current_price supplied by Meteora; not an executable quote",
          },
          volume24hUsd: nullableMetric,
          fees24hUsd: nullableMetric,
          binStep: { type: ["integer", "null"], minimum: 1, maximum: 65535 },
          blacklisted: { type: ["boolean", "null"] },
        },
      },
      PoolList: {
        type: "object",
        required: ["pools", "page", "perPage", "total", "hasMore", "dropped"],
        properties: {
          pools: { type: "array", maxItems: 25, items: { $ref: "#/components/schemas/Pool" } },
          page: { type: "integer", minimum: 1, maximum: 20 },
          perPage: { type: "integer", minimum: 1, maximum: 25 },
          total: { type: ["integer", "null"], minimum: 0 },
          hasMore: {
            type: "boolean",
            description: "Another indexed page exists; API supports pages up to 20",
          },
          dropped: { ...uint, description: "Malformed upstream rows excluded from this page" },
        },
      },
      Position: {
        type: "object",
        required: [
          "address",
          "pool",
          "owner",
          "mintX",
          "mintY",
          "decimalsX",
          "decimalsY",
          "lowerBinId",
          "upperBinId",
          "activeBinId",
          "binStep",
          "inRange",
        ],
        properties: {
          address,
          pool: address,
          owner: address,
          mintX: address,
          mintY: address,
          decimalsX: { ...uint, maximum: 18 },
          decimalsY: { ...uint, maximum: 18 },
          lowerBinId: bin,
          upperBinId: bin,
          activeBinId: bin,
          binStep: { type: "integer", minimum: 1, maximum: 65535 },
          inRange: { type: "boolean" },
        },
      },
      Capabilities: {
        type: "object",
        required: ["name", "readOnly", "features", "limits", "exclusions"],
        properties: {
          name: { const: "Studio Loco" },
          readOnly: { const: true },
          features: { type: "array", items: { type: "string" } },
          limits: {
            type: "object",
            properties: {
              maxPage: { const: 20 },
              maxPerPage: { const: 25 },
              maxRangeBins: { const: 69 },
              timeoutMs: { const: 15000 },
            },
            required: ["maxPage", "maxPerPage", "maxRangeBins", "timeoutMs"],
          },
          exclusions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

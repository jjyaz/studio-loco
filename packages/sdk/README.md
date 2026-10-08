# Studio Loco SDK · v0.1.1

A read-only TypeScript/ESM client for [Studio Loco](https://studioloco.cfd/developers), with range geometry, local Flight Recorder analysis and a genuine MCP server. Browser `fetch` or Node 20+; typed runtime validation, 15-second end-to-end timeout, bounded responses and cancellation. No private keys, signing, transaction submission or private cloud access.

## Install

```sh
npm install https://studioloco.cfd/api/public/loco/v1/sdk/0.1.1.tgz
```

This is a versioned downloadable npm package, **not a release on the npm registry**. Check the SHA-256 download header or Developer Station. Only the original code in this package is MIT licensed; dependencies retain their licenses.

```ts
import { LocoClient, planRange, analyzeRecorderExport } from '@studio-loco/sdk';

const loco = new LocoClient();
const page = await loco.listPools({ perPage: 5, sort: 'tvl' });
console.log(page.meta.source, page.data.pools);
const pool = await loco.getPool(page.data.pools[0]!.address);
// Supply actual PositionV2 and pool addresses:
// const position = await loco.getPosition(positionAddress, poolAddress);

const geometry = planRange({ lower: -10, upper: 9, active: 12 });
// Exact 20-bin recenter: [2, 21]. Geometry only, not a native transaction simulation.

// Local only, with an explicitly exported Recorder JSON object:
// const evidence = analyzeRecorderExport(JSON.parse(exportedJson));
```

## Read contracts

Every live response is `{ ok: true, data, meta }`; `meta` includes `apiVersion: "1"`, cluster `mainnet-beta`, source and `observedAt` (Unix ms). A position also carries `slot` for the pool/position snapshot and `mintSlot` for a subsequent mint read at or above it. `LocoError` carries `code`, `status` and `retryable`. Reads do not retry automatically. `signal` can cancel every client method. Unknown fields are stripped from responses for additive v1 compatibility; wrong API version, cluster or invalid types fail.

| Method | Source | Scope |
| --- | --- | --- |
| `capabilities()` | Studio Loco | Truthful features, limits, exclusions |
| `listPools(query)` | Meteora index | Pages 1–20, up to 25 rows; invalid rows counted as `dropped` |
| `getPool(address)` | Meteora index | Metadata and nullable metrics, no executable quote |
| `getPosition(address, pool)` | Solana confirmed | Genesis, DLMM program/discriminator, pool binding, owner, mints/program/decimals, exact range |
| `planRange(input)` | Local | Keep/recenter/optional wider geometry, up to 69 bins |
| `analyzeRecorderExport(bundle)` | Local export | Shared strict v1 model, duplicate/invalid/link/confirmation consistency counts |

An indexed response is not a chain snapshot. Null is unavailable, never zero. `hasMore` describes the index; page 20 is the API cap. Position reads do not calculate balances, fees or PnL and cannot authorize execution. The full app's Rebalance Planner still performs native builds, simulations, cost checks and a fresh wallet review. Recorder contents remain user-supplied claims; analysis does not independently confirm receipts.

## MCP

Hosted Streamable HTTP endpoint (public, no authentication):

```text
https://studioloco.cfd/api/public/loco/v1/mcp
```

Add that URL as a remote MCP server in a host supporting Streamable HTTP. Official MCP TypeScript server v2.3.1 supports 2026-07-28 with stateless legacy 2025 compatibility. No persistent server-initiated subscriptions. Five tools: `loco_capabilities`, `loco_list_pools`, `loco_get_pool`, `loco_get_position`, `loco_plan_range`. Read-only annotations describe actual read-only handlers; they are not relied on as permission enforcement.

For stdio hosts:

```json
{
  "mcpServers": {
    "studio-loco": {
      "command": "npx",
      "args": ["--yes", "--package", "https://studioloco.cfd/api/public/loco/v1/sdk/0.1.1.tgz", "loco-mcp"]
    }
  }
}
```

Add `--local-evidence` to explicitly enable a sixth **local-only** `loco_analyze_recorder_export` tool. It accepts an exported bundle as input, uses memory only, and never uploads it or reads arbitrary files. The hosted server does not register it. Stdout is reserved for JSON-RPC. `loco-mcp --help` explains configuration; `--base-url` accepts HTTPS or localhost for development.

## API

Base: `https://studioloco.cfd/api/public/loco/v1`. GET `/capabilities`, `/pools`, `/pools/{address}`, `/positions/{address}?pool=...`. Machine-readable specification: [`/openapi.json`](https://studioloco.cfd/api/public/loco/v1/openapi.json). Unknown/repeated query parameters are rejected. Generic RPC, devnet, credentials, wallet/history discovery and private Recorder reads are excluded. Fixed upstreams, bounded work/response sizes, isolated concurrency cap and explicit errors; no fixture fallback. Public pool/mint names are untrusted data, never assistant instructions.

## Development

From the repository root: `npm run sdk:build`, `npm run sdk:release` (reproducible package + manifest), `npm test`, `npm run build`. Package source lives in `packages/sdk`; app and SDK share the Recorder schema. Source examples include a browser/client read and local export analysis.

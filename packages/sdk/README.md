# Studio Loco SDK · v0.5.0

A read-only TypeScript/ESM client for [Studio Loco](https://studioloco.cfd/developers), with range geometry, local Flight Recorder analysis and a genuine MCP server. Browser `fetch` or Node 20+; typed runtime validation, 15-second end-to-end timeout, bounded responses and cancellation. No private keys, signing, transaction submission or private cloud access.

## Install

```sh
npm install https://studioloco.cfd/api/public/loco/v1/sdk/0.5.0.tgz
```

This is a versioned downloadable npm package, **not a release on the npm registry**. Check the SHA-256 download header or Developer Station. Only the original code in this package is MIT licensed; dependencies retain their licenses.

```ts
import { LocoClient, planRange, analyzeRecorderExport } from "@studio-loco/sdk";

const loco = new LocoClient();
const page = await loco.listPools({ perPage: 5, sort: "tvl" });
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

| Method                          | Source           | Scope                                                                                         |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `capabilities()`                | Studio Loco      | Truthful features, limits, exclusions                                                         |
| `listPools(query)`              | Meteora index    | Pages 1–20, up to 25 rows; invalid rows counted as `dropped`                                  |
| `getPool(address)`              | Meteora index    | Metadata and nullable metrics, no executable quote                                            |
| `getPosition(address, pool)`    | Solana confirmed | Genesis, DLMM program/discriminator, pool binding, owner, mints/program/decimals, exact range |
| `planRange(input)`              | Local            | Keep/recenter/optional wider geometry, up to 69 bins                                          |
| `analyzeRecorderExport(bundle)` | Local export     | Shared strict v1 model, duplicate/invalid/link/confirmation consistency counts                |

An indexed response is not a chain snapshot. Null is unavailable, never zero. `hasMore` describes the index; page 20 is the API cap. Position reads do not calculate balances, fees or PnL and cannot authorize execution. The full app's Rebalance Planner still performs native builds, simulations, cost checks and a fresh wallet review. Recorder contents remain user-supplied claims; analysis does not independently confirm receipts.

## MCP

Hosted Streamable HTTP endpoint (public, no authentication):

```text
https://studioloco.cfd/api/public/loco/v1/mcp
```

Add that URL as a remote MCP server in a host supporting Streamable HTTP. Official MCP TypeScript server v2.3.1 supports 2026-07-28 with stateless legacy 2025 compatibility. No persistent server-initiated subscriptions. Seven tools: `loco_capabilities`, `loco_list_pools`, `loco_get_pool`, `loco_get_position`, `loco_plan_range`, `loco_inspect_blueprint`, `loco_protocol_adapters`. Read-only annotations describe actual read-only handlers; they are not relied on as permission enforcement.

For stdio hosts:

```json
{
  "mcpServers": {
    "studio-loco": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "https://studioloco.cfd/api/public/loco/v1/sdk/0.5.0.tgz",
        "loco-mcp"
      ]
    }
  }
}
```

Add `--local-evidence` to explicitly enable four **local-only** tools: `loco_analyze_recorder_export`, `loco_analyze_continuity_export` `loco_analyze_switchyard_export` and `loco_analyze_mission_export`. It accepts an exported bundle as input, uses memory only, and never uploads it or reads arbitrary files. The hosted server does not register it. Stdout is reserved for JSON-RPC. `loco-mcp --help` explains configuration; `--base-url` accepts HTTPS or localhost for development.

## API

Base: `https://studioloco.cfd/api/public/loco/v1`. GET `/capabilities`, `/pools`, `/pools/{address}`, `/positions/{address}?pool=...`. Machine-readable specification: [`/openapi.json`](https://studioloco.cfd/api/public/loco/v1/openapi.json). Unknown/repeated query parameters are rejected. Generic RPC, devnet, credentials, wallet/history discovery and private Recorder reads are excluded. Fixed upstreams, bounded work/response sizes, isolated concurrency cap and explicit errors; no fixture fallback. Public pool/mint names are untrusted data, never assistant instructions.

## Development

From the repository root: `npm run sdk:build`, `npm run sdk:release` (reproducible package + manifest), `npm test`, `npm run build`. Package source lives in `packages/sdk`; app and SDK share the Recorder schema. Source examples include a browser/client read and local export analysis.

## Versioned blueprints · v0.2.0

Export one saved revision from [Strategy Foundry](https://studioloco.cfd/app/foundry). It includes a format/version, immutable identity and revision, exact mainnet pool/mints/bin step, decimal X/Y budgets, relative per-token weights, optional buy/sell ladders and action guards. It excludes wallet identity, RPC credentials, signers, transactions and private history.

```ts
import { inspectBlueprint, compileBlueprint, protocolAdapters } from "@studio-loco/sdk";

const inspection = await inspectBlueprint(exportedBlueprint);
console.log(inspection.digest, inspection.executable); // false
const geometry = compileBlueprint(exportedBlueprint, {
  activeBinId: observedActiveBin,
  decimalsX: verifiedXDecimals,
  decimalsY: verifiedYDecimals,
});
console.log(geometry.bins); // exact integer nominal budgets, not actual deposited balances
console.log(protocolAdapters()); // ordinary DLMM; Pro unverified and disabled
```

Inspection and compilation are local calculations on caller-supplied input. The SDK cannot authorize an action. Actual native weights use 16-bit quote-value precision and program rounding. The app re-verifies the chain and mint identities, composes one native transaction, simulates and checks its output, accounts for funding/fees/rent and obtains a fresh wallet approval. SHA-256 identifies configuration; it is not a signature, authenticity proof or verified receipt.

Strict imports reject unknown keys, instructions, RPCs, invalid budget precision, duplicate/noncontiguous liquidity offsets, incomplete weights and crossing/duplicate order levels. Up to 69 liquidity bins, 12 levels per order side and 25 KB per JSON blueprint; hosted MCP has its separate 16 KiB request cap. Ladders use separate capital from LP budgets and separate reviews. No earnings forecast or background execution.

## v0.3.0 · Journey Continuity

`analyzeContinuityExport(bundle)` validates the app's generated strict continuity contracts and reports recorded strategy/account/chapter/move counts and deduplicated reported network fees. It returns `chainVerified: false` and `executable: false`; supplied confirmations and ancestry have not been rechecked. The 10 MB decoder rejects invalid relations, duplicate strategy IDs, unsafe raw amounts and unknown fields.

```ts
import { analyzeContinuityExport } from "@studio-loco/sdk";
const summary = analyzeContinuityExport(exportedContinuity);
console.log(summary.chaptersRecorded, summary.moveStatesRecorded);
```

Local stdio with `--local-evidence` also registers `loco_analyze_continuity_export`. It receives a caller-supplied bundle in memory; it does not read files, upload data, open a wallet or sign. Evidence-analysis tools are not registered on the public HTTP MCP. SDK releases 0.1.0, 0.1.1 and 0.2.0 remain immutable at their existing download URLs; 0.3.0 is downloadable from Loco and is not published to the npm registry.

## v0.4.0 · The Switchyard

`analyzeSwitchyardExport(bundle)` validates strict prospective range-policy experiments and recomputes coverage from retained point observations, hypothetical decision counts, gap counts and network-fee budgets using the recorded user assumption. It returns `chainVerified: false`, `executable: false`, and `model: "range-policy-only"`.

```js
import { analyzeSwitchyardExport } from "@studio-loco/sdk";
const report = analyzeSwitchyardExport(exportedSwitchyard);
console.log(report.experiments[0]?.scorecards);
```

Coverage is a fraction of observed samples, not time in range. A sample is scored against the range that existed before its policy decision. Hypothetical actions assume immediate settlement after recording; token inventory, swaps, latency, slippage, earned fees and PnL are not modeled. Read failures and pauses reset the gap baseline. The app seals policy v1, retains 360 scored inputs per experiment and reports omitted history. Supplied files cannot authenticate source accounts, timestamps or chain history.

Opt-in local stdio adds `loco_analyze_switchyard_export`; no arbitrary file reads, upload or wallet access. The public HTTP MCP stays at seven tools. Direct SDK downloads 0.1.0, 0.1.1, 0.2.0 and 0.3.0 remain immutable. SDK 0.4.0 is downloadable from Loco, not published to the npm registry.

## v0.5.0 · The Conductor

`MissionPolicy`, `MissionScope`, `MissionSnapshot`, `MissionIntent` and `ConductorBundle` are runtime-validated shared contracts for the app's read-only liquidity missions.

```js
import { evaluateMission, previewMissionAction, analyzeMissionExport } from '@studio-loco/sdk';
const health = evaluateMission(policy, snapshot); // met | unmet | unknown
const preview = previewMissionAction(policy, snapshot, declaredIntent);
console.log(preview.executable); // always false
const report = await analyzeMissionExport(exportedMission);
console.log(report.sampledOutcomes, report.independentlyVerified); // supplied only, false
```

The ordinary-DLMM browser adapter verifies program/discriminators, mint identity, bin PDA/pool binding and one <=9-key quote snapshot context. It loads at most two bin arrays per direction, supports standard SPL Token mints, and requires full exact-input consumption. Missing coverage is unknown, never zero. Each ladder row is an independent quote, not a sequence of swaps. The price reference is the active-bin raw Q64 price. Fee-exclusive average execution deviation uses integer cross-products and rounds up to whole bps; total trading fees include both SDK LP and protocol portions and use the actual input/output fee currency. Token-2022 transfer effects are not modeled by this adapter. SDK dynamic-fee calculation uses the read's wall-clock window with a 60-second Solana-clock skew check.

Owner SOL/canonical ATA balances and optional Journey position inventory have separate read contexts. Canonical ATAs are not the whole wallet. Pool capacity includes other providers and native limit orders; it is never assigned to the tracked LP. A largest passing configured input is a sampled lower bound, not maximum depth, continuous service, future fills or profitability.

Policies are locally sealed, unsigned and versioned with canonical SHA-256 digests. Top-up caps are per operation, not total deployed inventory or a cumulative reservation. The pure preview checks declared scope/action/caps/expiry/cooldown and known declared SOL costs. Unknown costs or incomplete cooldown evidence require fresh evidence. Supplied operation figures are not instruction verification, native simulation, recipient checking or wallet authority. Conductor policy is not yet enforced in existing Planner/Foundry execution flows.

Mission export analysis is structural, digest and arithmetic validation. It recomputes outcomes at recorded times and never authenticates supplied chain observations or Recorder links. The opt-in **local stdio** tool `loco_analyze_mission_export` runs this analyzer in memory. Hosted HTTP MCP still has exactly seven public read-only tools, no private mission histories and no wallet access.

Device journal bounds: 20 missions, 20 immutable policy revisions and 120 retained observations per mission. Earlier omitted observations are disclosed. Visible-page monitoring samples only the selected mission; hidden tabs and read failures are gaps, not continuous monitoring. Hosted missions, cumulative reservations, operation enforcement, wider native adapters, Zap and Pro are future work. Prior SDK 0.1.0/0.1.1/0.2.0/0.3.0/0.4.0 download bytes remain immutable. Direct versioned distribution only; not published to npm.

# The Conductor v1 · liquidity missions

Conductor is a read-only mission workbench inside Studio Loco. It joins bounded live market-depth measurements, unsigned versioned local policies, owner and optional LP inventory, and Flight Recorder evidence. It does not add transaction authority.

## Scope and operation

- One ordinary DLMM mainnet pool per mission, exact owner/mints/precision/bin step and optional retained Journey position.
- Up to three strictly increasing exact-input probes in each direction, configured in token units. No implied USD conversion or equal-value matching between directions.
- Fresh isolated SDK instance. Program/discriminator checks, standard SPL mint initialization/precision checks, bin pool/PDA binding and chain-clock verification.
- At most two discovered bin arrays per direction. Pool, both mints, clock, optional bitmap and at most four distinct bin arrays are read in one <=9-account confirmed RPC context. A changed discovery that needs unloaded accounts fails for a fresh read. This avoids the relay's >10-account chunk split.
- SDK exact-input quotes require full consumption and positive output. Each row starts from the same frozen pool/bin account data. Unsupported sizes stay unknown; this read bound does not establish zero liquidity or maximum capacity. Native supported limit-order liquidity is included in pool capacity.
- Dynamic fees use the SDK's wall-clock read window; the clock must be within 60 seconds of verified Solana time. A quote is not a future fill guarantee.
- Price deviation uses active-bin raw Q64 price and exact integer cross-products of fee-exclusive average execution. Total fees include both SDK `fee` (LP portion) and `protocolFee`. Input fees are subtracted from effective input; output fees are added back to gross output. Round deviation and fee rate up to whole bps. Raw-unit rounding can produce a nonzero deviation on a small trade even inside one bin.
- Owner SOL/canonical ATA balances and optional independently checked Journey LP inventory have separate disclosed read contexts. ATAs are not the whole wallet and native SOL is not counted again as WSOL. Pool capacity is not credited to a tracked position. No atomic portfolio valuation, PnL, fee forecast or counterfactual post-deposit depth.

## Policies and evidence

Each policy revision has a canonical SHA-256 digest and immutable scope. It includes trade probes, separate impact/swap-fee ceilings, per-operation token top-up ceilings, minimum SOL reserve, network-fee ceiling, action families, cooldown, freshness and expiry. Zero top-up caps permit no declared token top-up; caps do not describe total deployed inventory. Local sealing is unsigned and does not prove address ownership.

The deterministic action preview checks supplied scope, action, token ceilings, expiry, cooldown completeness and declared SOL outflow. Missing native fee/rent/funding or incomplete recent-operation evidence remains unknown. Even `fits-declared-limits` is `executable: false`; supplied declarations are not instruction/recipient verification, native simulation or execution authority.

Existing Planner and Foundry links open their own fresh read/simulation/wallet-review flows. Those builders do not enforce Conductor policy in v1. Cumulative reservations and execution-policy enforcement require a separate operation-ledger release.

Durable-only IndexedDB storage checks actual stored revisions for mutations. Pause/revise/delete invalidates in-flight commits through CAS; deleted missions cannot be recreated by a late observation. Policies and retained measurements are append-only. Limits: 20 missions, 20 policies, 120 observations and 120 failed-read gap entries per mission. Omitted earlier entries are disclosed. A failed read preserves prior evidence and records a durable gap; it cannot present the prior successful read as current health.

Measurements commit before Recorder copies. Only absent or exactly matching local facts can be linked. Conflicting facts are preserved; temporary fallback storage is not acknowledged as durable. Repair links retained facts later without replacing measurements.

Monitoring samples only the selected mission every 60 seconds while the page is visible. Hidden tabs, failed reads and intervals between samples are not continuous service. Expired missions stop observing until a new policy revision. Closing the page stops observation.

## SDK 0.5

Shared `MissionPolicy`, `MissionScope`, `MissionSnapshot`, `MissionIntent`, `ConductorMission` and `ConductorBundle`; `missionPolicyDigest`, `missionQuoteMetrics`, `evaluateMission`, `previewMissionAction`, `exportMission` and `analyzeMissionExport`.

Bundle analysis validates structure, hashes and bindings and recomputes reported states at recorded times. Supplied observations and Recorder references are not independently authenticated chain receipts. `loco_analyze_mission_export` is opt-in local stdio only. Hosted HTTP MCP remains exactly seven public read-only tools. Prior 0.1.0/0.1.1/0.2.0/0.3.0/0.4.0 downloads remain byte-for-byte immutable. Direct package distribution; not an npm registry publication.

## Validation

Run:

```sh
npm test -- --maxWorkers=2
npx tsc --noEmit
npx tsc --noEmit -p scripts/qa/tsconfig.json
npm run sdk:release
npm run build
npx vitest run --config scripts/qa/config.ts scripts/qa/conductor-mainnet.acceptance.ts
```

Public read-only acceptance on 2026-10-14 verified SOL/USDC pool `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6` at slot **456945159**, with owner balances at slot **456945160**. Three distinct bin arrays were loaded. All six configured probes fully quoted: X raw 1,000,000/10,000,000/100,000,000 and Y raw 1,000,000/10,000,000/100,000,000. Observed deviation rounded to 1 bp and total fees to 5 bps for those probes. These are timestamped QA observations, not current rates or recommended trade sizes. The acceptance harness cannot broadcast, holds no wallet key and signs nothing.

Additional unit/integration checks cover fee-on-input/output, LP+protocol fee arithmetic, large exact amounts, partial/missing quotes, bad programs/discriminators/mints/bin bindings, rollback, unsupported Token-2022 effects, stale/future timestamps, missing position data, caps/cooldown/reserve, concurrent pause, policy edits, retention, deletion, gap retention, Recorder quota/collisions, public MCP isolation and watch-only/practice UI states.

Release checks: **513 tests across 52 files passed**, app and QA TypeScript checks passed, SDK 0.5 built and its packed ESM package successfully analyzed the public mainnet evidence, all prior archive checksums matched, and the production build passed. Worker count 2 avoids CPU contention in the existing large Switchyard retention test. The SDK 0.5 tarball SHA-256 is `a610b072595405edd1acba741b4b6559735bc939e3578a97ffcff0c7a11d8b58`.

## Deliberate release boundary

No cumulative budget reservation, hosted mission observer, autonomous/delegated signer, transaction-policy enforcement, wider native execution adapter, Zap or DLMM Pro integration is claimed. No financial transaction is required to use Conductor v1. Funded execution acceptance belongs to the existing wallet flows and future operation-ledger integration.

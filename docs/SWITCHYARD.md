# The Switchyard

The Switchyard links a tracked LP Journey to a prospective, device-local range-policy comparison. Its real account reads use the existing mainnet genesis, DLMM program/discriminator, owner/pool/mint verification, monotonic confirmed slots and account-byte corroboration. It never builds, signs or broadcasts a transaction.

## Comparison

- Actual account ranges as separately observed.
- Stay: preserve the initial range.
- Recenter: preserve its width, move the hypothetical range around the observed active bin when out of range or inside the selected edge threshold.
- Widen: include the prior hypothetical range and current active bin; increase by the selected step without exceeding the chosen cap.
- Record each action's policy version, input range, proposed target, input observation/recording times, slots and trigger.

Each sample is scored against the pre-decision range. A proposal affects later observations only; no hindsight improvement is permitted. Shadow actions assume immediate settlement after recording. No token inventory, swaps, execution latency, slippage, fee income or PnL is modeled. Coverage is a fraction of observed samples, not time in range. Network-fee budgets multiply proposals by a sealed user assumption; rent and other costs remain outside those budgets.

## Persistence

The page observes its selected running experiment once per minute while visible. It has no background keeper or hosted experiment observer. Pauses, failed reads and intervals above 150 seconds cause a disclosed gap; the first post-gap sample suppresses policy actions. The missed path remains unknown.

Source, baseline, policy and retained samples are immutable. Atomic stored-row CAS prevents cross-tab overwrites; atomic pause preserves concurrent observations and rejects stale captures. Errors cannot resurrect removed experiments or replace newer readings. Limits: 20 experiments, 360 scored observations each. Earlier prefixes are dropped with omission counts; scorecards cover the retained window.

Decision evidence is committed to Switchyard before its hypothetical range advances. Recorder copying uses deterministic IDs and refuses collisions; failures keep the durable decision available for explicit repair. Temporary Recorder storage is never acknowledged as durable. Source Journey updates are best effort and never recreate a removed watch.

## Fresh Planner handoff

A URL carries local experiment and decision identifiers only. A retained, latest, unexpired local decision can supply intent to Planner. Imported evidence is excluded. Recenter is recomputed from current state; a historical widening target must still include the current real range. Planner performs fresh reads and unsigned native simulations. Existing comparison/review TTLs, watch checks, semantic guards and fee caps remain. Shadow scope and freshness are checked again before signing and after wallet approval. No export or URL reconstructs executable inputs.

## SDK

SDK 0.4.0 shares strict contracts and recomputes reported scorecards with analyzeSwitchyardExport. It always returns chainVerified: false and executable: false. The opt-in local stdio tool is loco_analyze_switchyard_export; public HTTP MCP remains seven tools. Imports receive isolated IDs, remain paused and cannot enter monitoring or promotion. Previous SDK archives are retained byte-for-byte.

## Funded acceptance pending

User-wallet mainnet acceptance remains separate from read-only publication and automated validation. Run a Foundry-origin Journey through rebalance, claim and separately approved withdrawal/deposit; inspect Continuity chapters and source links. Then create a Switchyard comparison, observe it, pause/reload/resume, inspect Recorder evidence and request a fresh Planner review. Sign only after reviewing the wallet transaction. No automated test or hypothetical scorecard substitutes for this funded lifecycle check.

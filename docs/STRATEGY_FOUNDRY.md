# Strategy Foundry · SDK v0.2.0

The Observatory now has a mainnet Foundry at `/app/foundry`: immutable local blueprint revisions, custom per-token bin allocations, native buy/sell ladders, current fee inspection and fresh atomic wallet reviews. Each blueprint revision and SHA-256 digest links to its review and shared-runner action in Flight Recorder.

## Configuration and storage

Strict blueprint v1 schema is shared with the SDK. Exact decimal strings become u64 integer token units; largest-remainder apportionment preserves the nominal budget. LP offsets are sorted/contiguous with up to 69 bins. X is at/above active and Y at/below. Each funded token totals 10,000 basis points. Order sides each have up to 12 distinct levels and 10,000 bps of weights. Buy levels are below active, sell levels above. Ladder order and rounding are canonical regardless of input order.

Saved revisions are append-only in IndexedDB, checked against their digest on every read. Parent revision/digest compare-and-swap rejects concurrent stale saves. Imports create a local copy with a new identity; JSON never includes credentials, wallet identities, signed bytes, RPCs, instructions or private history. SHA-256 identifies content; it proves neither authorship nor performance. The device library is capped at 200 revisions and storage failures are visible.

## Native execution boundary

Fresh mainnet genesis, pool program/discriminator, exact mint identities/programs/decimals, chain clock, activation/status and fee configuration are verified. Plain legacy tokens and passive metadata Token-2022 extensions are supported; transfer/authority extensions are refused. Limit-order capability follows the official SDK and is rechecked before/after wallet approval. Pro is explicitly unverified: no invented program address, position model or execution adapter.

Weighted liquidity composes official IDL `initializePosition` + `addLiquidityByWeight2` instructions into one atomic transaction. Existing PositionV2 accounts must match the connected owner, exact pool and compiled bounds. Native 16-bit quote-value weights may differ from nominal per-token allocations after price/program rounding; unfunded zero weights are omitted, while funded weights lost to precision are refused. Orders use official `placeLimitOrder`, sorted absolute bin IDs and ephemeral account signers held only in memory. Each LP/buy/sell action has its own budget and review. Imported configuration never authorizes a transaction.

The shared native cost review simulates the exact unsigned message and returns writable account state. Foundry verifies target program/discriminator/pool/owner plus exact position bounds or order count/levels/side/raw amounts. Network fee, SOL outflow, wallet balance, new-account rent and temporary WSOL upfront rent must be known and affordable. Existing WSOL is spent first, only the deficit wraps, and existing accounts are never closed. Strict temporary ATA creation prevents a race from closing another pre-existing account. Actions above 1,232 bytes are blocked; users narrow the range or use existing accounts. No blind multi-transaction execution.

Reviews last 20 seconds after native preparation and Recorder persistence. Monotonic edit/identity generations prevent ABA reuse. Fresh pool state is checked before/after wallet approval; unresolved signatures block new work. All signing, final exact-message simulation and confirmation go through the existing shared runner. Success means confirmed; separately verified wallet deltas are not PnL or a position-state read. Native order placement is not a fill. The Foundry does not run a background keeper.

## SDK and MCP

SDK v0.2.0 exports blueprint parsing/canonicalization/digest, exact units/apportionment, local compilation/inspection and an honest protocol adapter registry. `loco_inspect_blueprint` and `loco_protocol_adapters` bring hosted MCP to seven read-only tools. Stdio has the same seven, plus an explicitly enabled eighth local Recorder-export analysis tool. No private device library, signer, transaction submission or cloud-history access. The public API version remains v1; previous 0.1.0/0.1.1 archives remain immutable. The npm package is distributed from Loco's versioned URL, not published on the npm registry.

## Validation

Source/SDK TypeScript and production build passed. Regression tests cover import strictness, canonical hashing/rounding, exact amounts, concurrent revisions, corruption/storage failure, ATA ownership/funding/WSOL preservation, invalid capability/fee gates, disconnected/practice/devnet UI, input changes during builds, pending signatures, Recorder persistence and shared-runner linkage/guards.

Real mainnet acceptance used unsigned simulations only: 3-bin weighted position, native two-level sell ladder, native two-level buy ladder and mixed 21-bin Curve X/Y liquidity. All target accounts passed identity and semantic verification; no native simulation error. Transactions were 635–972 bytes; the mixed 21-bin run used 166,484 compute units. No transaction was signed or broadcast and no funds moved. Browser-wallet funded mainnet approval remains a user-run acceptance check.

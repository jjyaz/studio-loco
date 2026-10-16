# Conductor operations · SDK 0.6

Conductor now connects explicit cumulative device budgets, durable operation evidence, supported native wallet reviews and opt-in private hosted observation. V1 mission policies retain their original per-operation top-up meaning; the arithmetic feasibility preview remains non-executable. No export or hosted copy becomes a signing permission.

## Financial state and review boundary

Missions, immutable budget revisions and operations share IndexedDB v2. Proposal, reservation, state transition and deletion checks are atomic. Competing tabs and overlapping missions for the same owner/network cannot open competing operations. A changed or removed mission cannot accept a late reservation. All consumed and unresolved amounts count across budget revisions; a new budget cannot be lower than those obligations. Budgets cannot outlive their bound policy. Storage failure refuses work; no memory fallback or timer-based release exists.

An operation retains proposed/reviewed/reserved/signed/submitted/confirmed/failed/rejected/expired/unknown states. Signature, exact compiled-message hash, blockhash and last-valid height persist before broadcast. Unknown outcomes retain their full reservation. Independently checked history absence after expiry releases an absent transaction; confirmed receipts must match the stored signed message and fee payer. Charged failed-transaction fees count as consumed. Successful SOL accounting counts gross owner-funded system transfers/account creation plus network fees; refunds do not replenish the cumulative budget automatically. Token debits are exact raw amounts, not PnL.

History is bounded without financial truncation: 20 budget revisions and 200 operations per mission. Full history refuses new work. Existing operation data is retained after a settled mission is removed; unresolved operations prevent removal. Other stations and other clients retain their own review boundaries. These are unsigned device controls, not deployed program permissions or custody.

## Supported native execution

Every spending request requires the connected exact owner and a fresh wallet approval through the shared transaction runner. The adapter verifies every installed-IDL instruction, account role, recipient, signer, mint and permitted remaining bin account. Empty SDK standard-SPL transfer-hook descriptors are accepted; nonempty hooks/rewards are refused. Native compute-budget instructions and canonical owner ATA creation are checked explicitly. Direct system/token transfers, approvals and account closes are not allowed.

Supported actions:

| Action         | Boundary                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Swap-fee claim | One retained Journey position, one native claim transaction, canonical owner ATAs                       |
| Withdrawal     | One native full-range percentage instruction; position remains open and WSOL remains wrapped            |
| Rebalance      | One atomic native instruction, same-width reviewed target, zero token top-up; no reward-harvesting pool |

Staged account setup, multiple transactions, new deposits/token top-ups, closure, rewards, Zap and DLMM Pro remain outside this adapter. Unsupported builds disclose a reason and cannot sign. Market capacity and native build contexts are separate fresh observations; no post-action depth or profit guarantee is inferred.

Before signing and after wallet approval, guards re-read the actual local policy/budget/reservation, verify the instruction fingerprint, recheck source owner/pool/range and native simulation/costs, SOL reserve, expiry and mission-local cooldown. Reviews expire after 20 seconds or earlier policy/budget/evidence expiry. Input, wallet, RPC, network and page changes invalidate an approval. Timed-out guard work retains the page's JobControl drain boundary. Imports cannot create executable operations.

Flight Recorder retains an immutable review linked to the actual shared-runner wallet record and Journey scope. Ledger settlement remains pending if a receipt or exact cost evidence is unavailable. There is no automatic resend or delegated signer.

## Private hosted observation

The user explicitly consents to copying the selected policy, addresses, trade sizes and public-chain observations into their private account. Hosted copies reuse Signal Box's existing five-minute cron, global unexpired worker lease, private RLS tables and shared five-watch account cap. No extra scheduler or signing key is provisioned. The worker independently verifies server-side position scope rather than reading browser IndexedDB.

Service-only `conductor_observer_commit` locks lease then watch and validates revision, active status, expiry, exact policy/snapshot scope and monotonically increasing observation count before the existing atomic commit. Pause/resume, explicit newer-policy copy and removal use owner/revision checks. Revise pauses until explicit resume. Generic Signal Box renewal cannot extend a mission beyond its sealed expiry. Failed reads retain explicit gaps; previous success is not current health. The last 60 attempts remain with omission counts; stored samples carry their recorded policy revision.

Five-minute scheduled samples do not imply continuous observation. A 30–150-second policy freshness window can expire between ticks; historical and current states are displayed separately. A scheduler heartbeat does not establish that every mission ran. Hosted settings/history never authorize local spending and are not exposed by public HTTP MCP.

## SDK and validation

SDK 0.6 shares budget/operation contracts, deterministic accounting/transitions and strict operation-evidence export analysis. `analyzeOperationLedger` checks supplied history/policy bindings and recomputes reported totals while returning `independentlyVerified: false` and `executable: false`. `loco_analyze_operation_ledger` is opt-in local stdio only. Hosted HTTP MCP retains exactly seven public read tools. Download archives 0.1.0 through 0.5.0 remain byte-identical. Distribution is a versioned tarball, not an npm-registry publication.

Validation commands:

```sh
npm test -- --maxWorkers=2
npx tsc --noEmit
npx tsc --noEmit -p scripts/qa/tsconfig.json
npm run sdk:release
npm run build
npx vitest run --config scripts/qa/config.ts scripts/qa/conductor-operations-mainnet.acceptance.ts
```

`scripts/qa/conductor-database.acceptance.sql` runs real PostgreSQL/RLS/CAS checks and rolls all public fixture rows and lease changes back. On 15 October 2026 it passed grants, owner isolation, lease expiry, pause/resume revisions, counter replay, read gaps and late writes after deletion. Unsigned public mainnet simulation passed fee claim, 25% withdrawal and zero-top-up native Spot rebalance on LP `1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id`, pool `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`.

Funded browser-wallet signing/broadcast acceptance is user-run and is not established by unsigned simulation or mocked lifecycle tests. No financial transaction was signed or broadcast while building this release.

The full-retention Switchyard replay test validates 365 immutable histories and now has an explicit 15-second CPU budget; its assertions are unchanged. Other control-path test timeouts are unchanged.

Release checks: **548 tests across 59 files passed**; app and QA TypeScript checks passed; SDK 0.6 built and its archive retained all prior version checksums; the production build passed. The server-side mainnet observer independently read and verified the public LP without accessing browser storage. SQL acceptance rolled back all fixture rows. Browser publication and scheduled-sample evidence are recorded below after deployment.

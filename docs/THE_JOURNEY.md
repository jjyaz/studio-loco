# The Journey

Live route: `/app/journey`. Ordinary mainnet Meteora DLMM only; Pro remains gated.

The Journey follows an exact Foundry revision into its confirmed LP position or native order account. It also supports explicitly entered public accounts, labeled watch-only. It never builds, signs or broadcasts transactions.

## Origin and evidence

The app shell listens for confirmed local Recorder actions. A matching, integrity-checked saved blueprint is required. `getTransaction` must return successful metadata with the expected wallet signer, writable target, exact pool and the SDK IDL's native weighted-liquidity or order-placement discriminator. The resulting account must independently pass genesis, program, discriminator, pool, owner and mint checks. Missing metadata/accounts remain pending; the Journey page provides an explicit retry. Imported/cloud records cannot become automatic origins.

Revision/digest is device configuration evidence, not cryptographic proof of an onchain strategy. A linked account may have additional activity before/after that action; its balances and lifetime counters are not attributed entirely to the blueprint.

## Observation model

The reader loads fresh pool and account identities, checks initialized mint programs/precision, hydrates through Meteora's SDK and corroborates unchanged target bytes after hydration. It records the identity and corroboration slots and enforces nondecreasing contexts. The SDK uses multiple confirmed reads for bin arrays and holdings: this is explicitly disclosed, not advertised as an atomic same-slot financial snapshot.

LP views show whole-base-unit holdings, per-bin shares, range state, unclaimed fees and account-lifetime claimed counters. Order views keep deposited/fulfilled input, swap output and withdrawable tokens distinct. SDK UI order amounts are converted with decimal-string arithmetic; LP fractional raw amounts are floored. Order lifetime claimed counters are unavailable.

The first successful read establishes a baseline. Changes have a previous-read/current-read interval, not an exact execution timestamp. A removed level is withdrawn/reset *observed*, without inventing its cause. A missing account stays unavailable; it is never presumed closed or filled. Failed reads preserve earlier snapshots and display their failure. Selected accounts refresh every 60 seconds while the page is visible and become stale after 150 seconds. Reads have per-step and overall deadlines and generation cancellation.

## Persistence and accounting

IndexedDB retains 100 accounts, 48 snapshots and 200 changes per account, with loss counts. Writes/removals use atomic revision compare-and-swap across tabs. Storage failures do not fall back to pretend persistence. Exports contain public identifiers/device observations, no wallet/RPC credentials or executable inputs. An export is evidence supplied by its owner, not authenticated history.

Accounting reports only independently verified linked Foundry network fees, deduplicated by signature and charged to the owner only when it was fee payer. It separately displays current account SOL and the rent-exemption minimum. Other transaction costs, bin-array rent, funding, transfers and closure refunds remain outside that fee total. Claimed fees can predate the Journey. No PnL, yield forecast or inferred profit is displayed.

## Alerts and handoffs

Private Signal Box range watches reuse the existing LP rules. New native-order watches reuse the same five-minute scheduler, seven-day expiry, five-watch cap, RLS, lease/CAS-gated commits, durable inbox and optional push registration. Creation starts from a fresh server read. Partial/filled/removed-level changes are compared between successful observations; errors, pause/resume and gaps over 12 minutes reset continuity.

Order alert links carry only the private alert UUID. The handoff reauthenticates the current account, validates the current watch revision/status/expiry, reloads identifiers and checks fresh mint identity. Old alert values never become transaction inputs. Planner and native-order controls reread the chain and retain their existing wallet approval flow. Device watch removal does not delete a hosted watch.

## Validation

- Regression tests, dedicated precision/provenance/transaction/slot/retention/CAS/UI tests, source typecheck and production build.
- Read-only mainnet acceptance: repeated real LP snapshots and a populated native order account through the public relay; no signing/broadcast paths. Public-provider history may be pruned; unavailable placement metadata is explicitly unverified.
- Funded end-to-end Foundry-origin capture needs a user-approved Foundry transaction. This release does not claim the assistant performed one.
- Hosted inbox/worker behavior is verified separately; actual browser push delivery depends on the user's opt-in device and provider.
- Deployed browser acceptance saved real public LP/native-order accounts, refreshed them, exported exact bounded evidence without credentials and restored both after reload.
- Deployed hosted order acceptance produced four successful observations and one deduplicated private alert, with no failed reads. The transition test deliberately used a simulated previous baseline against a real filled native order; it is not evidence of a new market fill. The isolated disposable fixture and inbox rows were removed afterward.

Primary reference: https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference and installed `@meteora-ag/dlmm` IDL/wrappers.

## Journey Continuity

The strategy board at `/app/journey` retains one device strategy identity across the account lifecycle. An independently checked Foundry origin creates the identity; v1 account watches and snapshots remain unchanged. The original revision/digest, origin receipt, linked accounts and account histories survive subsequent actions. Multiple blueprint contributions are visible as conflicts; an account's full balance is not attributed to one blueprint.

The shared transaction runner records public instruction targets and locally reviewed move intent before wallet approval. Only confirmed steps from local wallet records plus local prepared facts qualify for verification. Direct native DLMM instruction roles must bind the exact owner, target and pool. Closures without an LbPair instruction account require prior verified identity; the successful target-bound closing instruction must be followed by an absent read at/after its slot. Missing/pruned transaction metadata remains unresolved. For a previously verified member that later disappears, a successful target-bound historical action can be retained with an explicitly unavailable post-account snapshot; it never implies closure. New destination membership still requires a fresh verified resulting account. Account/bin creation preflights do not masquerade as rebalances.

Supported chapters: Foundry origins, native weighted/strategy deposits, native rebalance, swap-fee/reward claims, withdrawals, native order placement/cancellation and target-bound closures through existing wallet flows. Capture runs while the app is open and on hydration; pending signature reconciliation can supply later confirmations. Verification retries read evidence only and never replay or resume a transaction. Earlier untagged actions are not reconstructed.

Moves are non-atomic, separately approved source withdrawal and destination deposit. The source retains its locally reviewed destination pool; a query pointer alone cannot create ancestry. A new destination must match that pool, owner, mint addresses/precision and a source withdrawal earlier in chain order. Source pending, source verified, deposit pending, complete and interrupted states persist. Journey can reopen a fresh destination review after reload; wallet inputs are rebuilt, not restored execution payloads. Approval-time checks refuse an already completed/deleted/ambiguous move.

Before/after views retain observation/corroboration slots, ranges/bin step, exact per-mint holdings, fee/counter balances and a bounded allocation preview (70 bins; total read count disclosed). A later corroboration cannot be labelled before an action. Source/destination comparisons join mint addresses rather than X/Y labels. All observations may include unrelated account activity; no same-slot financial snapshot, token tracing, execution output attribution or PnL is claimed. Known owner-paid network fees are deduplicated by signature, with conflicting/unknown values withheld. Totals describe retained linked receipts, not all lifetime costs; preflight infrastructure, rent, transfers and refunds remain outside them and can be reviewed in Recorder.

Persistence: 50 strategies, 20 accounts and 20 moves per strategy, 200 retained chapters with omission counts. Original and referenced move/closure receipts are protected. Atomic cross-tab CAS validates immutable origin, ancestry, retained chapter content and confirmed stages against the actual stored row. Removal retires the origin so migration cannot silently recreate it; explicit recovery restores the original account association without signing. Storage failures have no pretend durable fallback.

Continuity v1 evidence exports contain strategy records v2 and strict public/device metadata, bounded to 10 MB. Imports validate relations and IDs, retain the supplied ID separately, create isolated local IDs and force supplied provenance on every association. They cannot enter automatic capture. Manual account groups remain explicitly watch-only. SDK 0.3.0 validates/analyses the same contracts; opt-in local stdio MCP inspection processes only caller-supplied data in memory, never private device storage or cloud history.

Funded end-to-end acceptance is still required from the user's own wallet: save a Foundry revision, approve creation, verify its origin, perform a native rebalance/claim, then a separately approved source withdrawal and destination deposit, reload and export. No assistant signed or broadcast during this release. Pro remains gated.

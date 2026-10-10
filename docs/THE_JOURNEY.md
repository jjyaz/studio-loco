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

Primary reference: https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference and installed `@meteora-ag/dlmm` IDL/wrappers.

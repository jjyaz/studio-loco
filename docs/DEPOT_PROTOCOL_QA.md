# Depot protocol acceptance

This document records **unsigned protocol checks**, not a deployed agent token or funded wallet acceptance.

On 20 October 2026 the app's `prepareDepotLaunch` adapter was tested against Solana mainnet using the pinned official DBC SDK 1.5.11. The harness overrides both broadcast methods to throw. It never calls a wallet or signs a transaction. Config/mint keypairs stay in memory and are discarded.

Run explicitly:

```sh
npx vitest run --config scripts/qa/config.ts scripts/qa/depot-mainnet.acceptance.ts
```

The ordinary unit suite never runs this network check. The generated `.qa/depot-unsigned-mainnet.json` contains public identifiers and measurements only.

## Observed result

| Check | Result |
| --- | --- |
| Network | Verified mainnet genesis hash |
| Preset | `small-sol-20@1`, 100 million whole tokens, six decimals |
| Metadata | Explicit in-memory test fixture at a realistic 113-byte project URI; **not publicly published** |
| Transaction | Atomic DBC config + standard SPL token/pool; no initial buy |
| Instruction proof | Installed IDL names, account privileges, program IDs and owner recipients checked |
| Packet | 1,170 bytes; three required signatures; all unsigned |
| Network fee | 15,500 lamports |
| New account funding | 26,555,720 lamports |
| Simulation | Passed preparation and fresh-cost recheck |
| First observed slot | 459340398 at 19:07:56 UTC |
| Simulated state | Decoded program-owned pool/config/mint from the second simulation context, slot 459340421 |
| Identity checks | Derived pool PDA, owner recipients, immutable mint/freeze authorities and creator's permanent LP allocation passed |
| Simulated migration charge | 20 bps protocol liquidity migration fee, separately read from pool state |
| Signed / broadcast | **No / no** |

The simulated accounts were not created on chain. The harness temporarily supplies simulation output to the lifecycle decoder to verify its account layout and identity checks; it does not promote those accounts into a passport, receipt or real lifecycle record.

DBC pool/config/mint and current curve fees are decoded from one confirmed account context. Graduated DAMM pool and NFT position reads use separate disclosed contexts. A pool slot must not be presented as the slot of every later position read.

Meteora's [DBC formulas](https://docs.meteora.ag/core-products/dbc/formulas) describe the separate 0.2% protocol liquidity migration charge. It reduces migrated deposits; it is distinct from configurable partner/creator migration fees and the migrated pool's swap fee tier. Current onchain state remains the authority for a specific pool.

## Unit boundaries

The SDK proof suite builds real official SDK config/pool, migration, curve-claim and DAMM-claim instructions with injected read fixtures. It rejects additional transfers, changed recipients and remaining accounts. SDK claim account-close helpers are removed so existing owner WSOL stays open.

The durable ledger suite checks concurrent IndexedDB connections, pre-broadcast signature/message and metadata/preset-intent persistence, reload recovery, reserve-intent changes, post-wallet fresh-cost refusal and unsigned-only reservation release. An unresolved signed operation has no automatic timeout release or resend path.

Final regression suite: 612 tests in 66 files passed. The production build and TypeScript check passed. `depot-atomic.acceptance.sql` passed against the deployed migrations and ended with its intentional `DEPOT ATOMIC ACCEPTANCE PASSED (forced rollback)` exception; all fixtures were rolled back. It covers immutable/idempotent publication, ownership, current holder policy, proof/read freshness, launch CAS/idempotency, immutable launched controller and function grants. It does not perform chain receipt verification or create real token metadata.

## Still requires the owner's wallet

Browser-wallet message proof, public HTTPS metadata publication, a funded launch, exact receipt-to-passport attachment, actual fee accrual/claim, graduation and holder-gated access need an explicit owner-run rehearsal. No result above proves those financial actions happened. There is no hosted signer, delegated key custody, automatic launch, token purchase or guaranteed operating income.

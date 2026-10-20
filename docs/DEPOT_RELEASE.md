# The Depot release

## Result

`/app/depot` provides private Scout drafts, signed controller proof, explicit passport publication, immutable agent-specific token metadata, two versioned DBC launch presets, Scout reports and server-enforced holder access. `/depot/:id` is the public passport. Navigation includes The Depot, with entry points from Launch Station, Liquidity Agents, Docs and Developer Station.

The workspace follows the existing night-train visual language: panoramic station imagery, cobalt and cream surfaces, amber signals, oversized editorial headings and a seven-stage workflow rail. Loading, empty, unavailable, refusal and recovery states are explicit. Public reports can be produced without creating a token.

DBC config and pool creation is atomic, standard SPL/SOL only, using official SDK 1.5.11. DAMM v2 uses official SDK 1.4.5. The creator receives all non-protocol curve fees and the permanent migrated LP allocation. The separate 0.2% protocol liquidity migration charge is disclosed. Graduation, curve/DAMM claims and a SOL reserve transfer are separate wallet-reviewed actions. Existing WSOL remains open; claims do not silently unwrap or fund a reserve.

Reviews bind financial form intent, wallet/network/connection generation, agent revision, immutable metadata, recipients and costs. Exact simulation/cost and server agent/metadata checks run on both sides of wallet approval. Durable IndexedDB reservations serialize across tabs; signed evidence and launch intent persist before broadcast. Unknown signatures cannot be resent or released on a timer. Successful receipt verification compares the exact signed message; launch attachment additionally reconstructs the original SDK transaction on the server and verifies protocol identity.

Holder reports require a recently proven connected wallet and a fresh mainnet balance. Delivery rechecks the agent's current revision, visibility and gate in one SQL statement. Client state is scoped to account/wallet/agent epochs so late responses cannot cross wallet changes. No private reports or financial actions were added to the public SDK or MCP.

## Validation

- TypeScript source check and production client/Worker build passed.
- 612 tests passed in 66 files, including seven new wallet/access UI interaction tests.
- Live mainnet unsigned app-adapter simulation passed, with simulated post-state identity decoding, a 1,170-byte packet, 15,500-lamport network fee and 26,555,720-lamport new-account funding. These are observations for the tested preset, not a fixed future quote.
- Deployed database migrations 0003–0007 are applied. Both rollback-only DB acceptance scripts passed, including current-policy delivery, immutable publication and launch identity boundaries. Test fixtures were not retained.
- Earlier live read-only Scout and optional AI commentary checks passed. AI text is qualitative, fact-referenced and never execution permission.

## Deployment and owner acceptance

Source sync to Lovable is distinct from publishing the production site. Publishing uses Lovable after the combined source passes validation. Neither implementation nor publication signs, funds, buys or launches a token. Public metadata preparation verifies studioloco.cfd endpoints and refuses if that domain still serves an earlier release without the metadata routes.

An owner-run acceptance pass is still needed after publishing: wallet sign-in, controller message proof, a real metadata publication, funded launch, unknown/confirmed receipt recovery and passport link, fee accrual/claims, DBC graduation and a real holder-wallet report read. The available preview browser hit a Lovable sign-in wall, so React DOM tests and compile checks do not constitute a full authenticated browser walkthrough.

V1 has no hosted private key, delegated financial autonomy, automatic token purchase, automatic reinvestment or guaranteed operating income. A reserve transfer records a wallet-reviewed payment and does not prove ownership of the receiver or automatically authorize future spending.

## Earlier Lovable verification matrix

| Area | Implemented | Verified here | Still needs funded wallet acceptance |
| --- | --- | --- | --- |
| Agent drafts, edit, delete, publish/unpublish | Server fns + RLS, revision CAS | Unit + DB rollback tests | — |
| Wallet proof (controller / viewer) | ed25519 over exact server challenge, single-use nonce, launch-bound controller | Unit + DB tests (wrong wallet/user/domain/expired/replay) | Real browser wallet `signMessage` |
| Immutable metadata | Hash-addressed body + image served from this site, immutable triggers | Integrity route tests | Publish from the public HTTPS site |
| DBC launch (2 SPL/SOL presets) | Official SDK 1.5.11 builder, instruction checks, simulation, costs, 20 s review, caps, pre-sign + post-approval rechecks, device ledger | 32 SDK adapter tests, TS, build | Signed mainnet launch |
| Verified launch linkage | Server rebuilds exact original message (preset, owner recipients, keys, metadata, CU 500k/1000 µL, blockhash), byte-compares receipt, reads DBC/mint/config, atomic `depot_link_launch` CAS, unique mint/signature | Reconstruction tests: determinism, wrong preset/payer/metadata/pool/owner/failed tx | Real receipt link |
| Graduation to DAMM v2 | Official migrate builder, separate review | Builder tests | Ready-to-graduate pool on mainnet |
| Creator curve + DAMM fee claims | Official builders, WSOL preserved | Builder tests | Real claimable fees |
| Operating reserve | Separately reviewed SOL transfer | Builder tests | Real transfer |
| Scout reports | Server reads via Conductor adapter, deterministic facts | Live read-only SOL-USDC read | — |
| AI commentary | Fact-ID-referenced, number-free, bounded stream, timeout, refusal/error rejection | Unit tests; live gateway call earlier | — |
| Holder-gated reports | Fresh confirmed SPL balance of a proven viewer wallet, ≤60 s | Gate unit tests | Real holder wallet |
| UI `/app/depot`, `/depot/$id` | Passport, Token launch, Scout, Fee desk, operations ledger | Desktop + 390 px signed-out render, no overflow/errors | Signed-in workspace browser pass (no auth user for the QA session) |

Not supported: Alpha Vault, custom curves, delegated autonomy, hosted signing, Pro graduation, token purchases.

## Wallet sign-in update

The Depot and holder-report access now use wallet-only sign-in with secure server sessions; no email/password form. Each protected request binds the session to the connected wallet and server-derived principal. See `DEPOT_WALLET_AUTH.md`. Financial wallet approval and the funded launch/graduation acceptance status are unchanged.

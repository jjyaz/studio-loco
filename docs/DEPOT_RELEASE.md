# The Depot — release matrix

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

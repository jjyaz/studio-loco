# Studio Loco — Research & capability mapping

Studio Loco is an original Solana product: a working Meteora DLMM interface plus an honest,
educational coordination lab. It is **not** a fork or port of The Interfold's cryptography.

## Sources
- The Interfold (formerly Enclave): https://www.theinterfold.com/ — Ethereum confidential-coordination protocol (LGPL-3.0+ source).
- Meteora DLMM: https://docs.meteora.ag/core-products/dlmm/what-is-dlmm, strategies: https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases
- SDK: https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/getting-started · examples · reference · https://github.com/MeteoraAg/dlmm-sdk
- Pools API: https://docs.meteora.ag/api-reference/dlmm/pools/pools (`https://dlmm.datapi.meteora.ag/pools`)
- Installed SDK: `@meteora-ag/dlmm@1.9.14` — signatures verified against `dist/index.d.ts`.

## Interfold → Studio Loco mapping

| Interfold area | What it is there | Studio Loco equivalent | Status |
|---|---|---|---|
| E3 lifecycle (request → committee → DKG → encrypted inputs → proved compute → threshold decrypt) | Real protocol | `/lab` lifecycle with AES-GCM + SHA-256 commitments, single local key | Local simulation |
| FHE (BFV), ZK proofs | Cryptographic guarantees | None. Explicitly listed as missing in `/lab` | Not deployed |
| Ciphernode network, operator dashboards | Rust nodes, bonding | `/network` = real Solana RPC + DLMM program observatory | Live (different scope) |
| FOLD bonding / slashing / tickets | Economic security | None; no token | Not deployed |
| CRISP secret ballots | Private governance | `/lab?mode=ballot` + `/governance` local decision room | Simulation |
| Sealed-bid auctions | Confidential auctions | `/lab?mode=sealed-bid` (second-price aggregate) | Simulation |
| Avail data availability | DA layer | Described in `/lab/architecture` | Not deployed |
| Tokenomics | FOLD | `/token`: LOCO not deployed; planning worksheet labelled proposal | Not deployed |
| Docs, journal, community | Content | `/docs`, `/journal` original content | Live |
| — (no DEX) | — | DLMM terminal, swaps, liquidity, portfolio, studio, signals, launch | Live |

## Important port limits
- Meteora DLMM is public. It provides no FHE, private ballots, sealed bids or encrypted order flow.
- Browser encryption with one key gives none of the committee / threshold / verifiability guarantees.
- A Solana-native confidential deployment would need e.g. Arcium MXE/Arcis + Anchor verifier/callback program, authenticated input binding, replay protection, committee selection, DA, disclosure controls, settlement, economic security and audits (see `/lab/architecture`).

## Implementation status
Single source of truth: `src/lib/capabilities.ts` (rendered on `/network`). Summary:
- **Live (real API/chain/SDK):** pool list, pool detail + Rail Map, direct swap (swapQuote/swap), add liquidity (initializePositionAndAddLiquidityByStrategy, ephemeral keypair in memory), portfolio (mainnet: Meteora index + on-chain verification of program, PositionV2 discriminator, pool and owner, with watch-only mode; devnet: getAllLbPairPositionsByUser), native limit orders (place/cancel/close; mainnet indexed discovery + verified SDK getLimitOrder), mainnet OHLCV price history, claim (claimSwapFee, claimAllRewardsByPosition), withdraw/remove/close (removeLiquidity, closePosition), Signal Box polling + two-step rebalance, Fee Weather, Launch Station (getAllPresetParameters → createLbPair2 with derived-address duplicate check), network observatory.
- **Simulation:** Practice mode data, Studio shape previews/scenarios, Lab, governance room, token worksheet.
- **Handoff only:** DBC / DAMM v2 / Alpha Vault.
- **Not deployed:** confidential compute network, ciphernodes, LOCO token, DAO.

## Engineering notes
- Public Solana RPC returns 403 to browser origins, so `/api/public/rpc/$cluster` relays an allowlist of JSON-RPC methods (no secrets). Users can set their own HTTPS RPC in Settings, which bypasses the relay. `getProgramAccounts` (portfolio, presets) is often throttled on public RPC — a dedicated RPC is recommended.
- Signing requires the wallet's signTransaction (no sendTransaction fallback); the RPC genesis hash must match the selected cluster; wallet/network identity is re-checked after approval and before broadcast; unresolved signatures are persisted (public metadata only) for Check status reconciliation.
- Confirmation polls `getSignatureStatuses` and fails when block height passes `lastValidBlockHeight`; success is shown only after `confirmed` without error.
- All amounts are parsed from decimal strings into BN base units (`src/lib/amount.ts`).

## Next operational requirements
1. Funded mainnet/devnet wallet QA for swap, add liquidity, claim, withdraw, close, and pool creation (not performed in this build; no wallet/funds in CI).
2. Dedicated RPC provider for production (rate limits, getProgramAccounts).
3. Funded signing of native limit orders (implemented and simulated only).
4. Any confidential feature requires a deployed, audited MPC/FHE program — out of scope.

## Funded testing blocker
The devnet faucet returned `429 — airdrop limit reached today or faucet dry` for fresh throwaway keypairs, and a later devnet probe timed out before funding. No funded transaction has been signed or confirmed on any network. There is no LOCO token, private committee, DAO or audit.

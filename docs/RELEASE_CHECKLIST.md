# Release readiness

Not production-ready: no funded wallet has signed any transaction built by this app.

| Item | State | Evidence |
|---|---|---|
| Typecheck (`tsgo --noEmit -p .`) | Pass | 0 errors |
| Unit tests (`vitest run`) | Pass — 44 tests, 3 files | `core.test.ts` (16): amounts, strategy shapes, bin math, API retry/errors, practice data, lab. `hardening.test.ts` (27): classic + Token-2022 program IDs (old wrong ID rejected), mint parsing/extension blocking, SOL reserve, exact-message simulation, signed-bytes mismatch refusal, ephemeral signer, narrow rejection classification, bounded confirmation → unknown, proven expiry vs failed history lookup, onchain error, empty sequence, stop on unknown, route v2 schema/v1 migration/width/PublicKey/share, relay validation. `app-routing` (1) |
| Production build (`bun run build`) | Pass — exit 0 | |
| All routes render, WebGL disabled, 390 / 768 / 1280 px | Pass | 17 routes × 3 widths, 0 page errors, 0 document horizontal overflow; terminal table scrolls inside its own frame |
| Hero art | Pass | Train and field visible at 390 and 1280; headline on clean sky |
| Live pool list, real bins, limit-order mode detection | Pass | YZY-USDC active bin −124, mode Undetermined → order-capable per SDK |
| Wallet absence | Pass | every action shows Connect wallet; nothing auto-transacts |
| Keyboard focus, wallet modal, dialogs | **Not re-verified this pass** | |
| Devnet integration (create/add/swap/withdraw/close/orders) | **Not run** | no disposable devnet wallet run was performed this pass |
| Funded wallet signing (all flows incl. native orders) | **Not run** | requires human approval |
| Confidential protocol | **Not deployed** | educational simulation only |

## Pass 4 (2026-10-06 12:06 UTC)
- Add Liquidity review now shows SDK `quoteCreatePosition` estimates (position + realloc, new bin arrays, bitmap extension, SOL) plus network fee; token-account rent noted as excluded; exact simulation enforces affordability. Max SOL wording no longer implies 0.05 SOL covers all rent.
- Swap price impact: verified in installed SDK — `priceImpact = |start−end|/start × 100`, i.e. already a percent; displayed with fmtPct unchanged.
- Fee rates below 0.0001% now show significant digits instead of 0.0000%.
- Price-history chart labels enlarged for 390px; edge dates anchored to avoid clipping.
- Devnet faucet retried with a fresh in-memory keypair: still `429 — airdrop limit reached today or faucet dry`. No funded devnet operations executed.
- Indexed open limit orders listing (`/wallets/{w}/limit_orders/open/pools/{p}`) not yet wired; orders are read on chain via the SDK.

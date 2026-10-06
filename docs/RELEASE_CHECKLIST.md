# Release readiness

Not production-ready: no funded wallet has signed any transaction built by this app.

| Item | State | Evidence |
|---|---|---|
| Typecheck (`tsgo --noEmit -p .`) | Pass | 0 errors |
| Unit tests (`vitest run`) | Pass — 64 tests, 4 files | core, hardening (tx runner incl. identity change during approval and hung block-height → unknown; indexed account verification vs SDK IDL discriminators; ≤100 chunking; open-orders pagination caps), anchor-runtime, app-routing |
| Production build (`bun run build`) | Pass — exit 0 | |
| All routes render, WebGL disabled, 390 / 768 / 1280 px | Pass | 17 routes × 3 widths, 0 page errors, 0 document horizontal overflow; terminal table scrolls inside its own frame |
| Hero art | Pass | Train and field visible at 390 and 1280; headline on clean sky |
| Live pool list, real bins, limit-order mode detection | Pass | YZY-USDC active bin −124, mode Undetermined → order-capable per SDK |
| Wallet absence | Pass | every action shows Connect wallet; nothing auto-transacts |
| Keyboard focus, wallet modal, dialogs | Pass (pass 5, /app at 1280px) | Skip link first; nav, Settings, Connect wallet, tabs, Refresh, inputs all show focus (search via amber frame); Enter opens wallet dialog, Escape closes it; 0 page errors |
| Devnet integration (create/add/swap/withdraw/close/orders) | **Not run** | no disposable devnet wallet run was performed this pass |
| Funded wallet signing (all flows incl. native orders) | **Not run** | requires human approval |
| Confidential protocol | **Not deployed** | educational simulation only |

## Pass 4 (2026-10-06 12:06 UTC)
- Add Liquidity review now shows SDK `quoteCreatePosition` estimates (position + realloc, new bin arrays, bitmap extension, SOL) plus network fee; token-account rent noted as excluded; exact simulation enforces affordability. Max SOL wording no longer implies 0.05 SOL covers all rent.
- Swap price impact: verified in installed SDK — `priceImpact = |start−end|/start × 100`, i.e. already a percent; displayed with fmtPct unchanged.
- Fee rates below 0.0001% now show significant digits instead of 0.0000%.
- Price-history chart labels enlarged for 390px; edge dates anchored to avoid clipping.
- Devnet faucet retried with a fresh in-memory keypair: still `429 — airdrop limit reached today or faucet dry`. No funded devnet operations executed.
- (Superseded in pass 5: indexed open orders wired.)

## Pass 5 (2026-10-06)
- Live site 500 root cause (worker logs): `@solana-mobile/wallet-adapter-mobile` crashed at import (`superCtor.prototype` undefined) in the Worker. Server builds now resolve it to a stub; the browser keeps the real package. Built server verified in workerd (wrangler dev): `/`, `/app`, `/app/portfolio`, `/lab`, `/docs`, `/favicon.png` → 200; RPC relay forwards (upstream returned 403 to the sandbox IP).
- tx: block-height lookup bounded (10s → unknown); identity re-checked after wallet approval, before persist/broadcast.
- Portfolio: PositionV2 discriminator + program + pool + owner verified; reads chunked ≤100; abort honoured; rejected rows and index truncation shown.
- Orders: mainnet indexed `/wallets/{w}/limit_orders/open/pools/{p}` (page_size 50, ≤5 pages, truncation shown), each address verified on chain then read with SDK `getLimitOrder`; devnet/custom RPC keep the SDK scan.
- Funded tests: devnet faucet 429 and devnet probe timeout — no funded operation executed.

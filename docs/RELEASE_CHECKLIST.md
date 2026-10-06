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
- Default mainnet upstream switched to PublicNode's free keyless endpoint after `api.mainnet-beta.solana.com` 403d hosted-Worker IPs. Verified from the sandbox 2026-10-06: `getGenesisHash` = `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (exact mainnet match), `getSlot` live, DLMM program and top-TVL pool `getAccountInfo` return real data. `SOLANA_MAINNET_RPC_URL` server override still takes priority; devnet unchanged (public Solana endpoint, custom RPC in Settings as fallback). Deployed-relay behavior not yet verified from production — check after publish.
- tx: block-height lookup bounded (10s → unknown); identity re-checked after wallet approval, before persist/broadcast.
- Portfolio: PositionV2 discriminator + program + pool + owner verified; reads chunked ≤100; abort honoured; rejected rows and index truncation shown.
- Orders: mainnet indexed `/wallets/{w}/limit_orders/open/pools/{p}` (page_size 50, ≤5 pages, truncation shown), each address verified on chain then read with SDK `getLimitOrder`; devnet/custom RPC keep the SDK scan.
- Funded tests: devnet faucet 429 and devnet probe timeout — no funded operation executed.

## Pass 7 — client hydration (2026-10-06)
- Root cause: the production client build resolved every `node:buffer` import to Vite's empty `__vite-browser-external` stub; safe-buffer read `undefined.from` while loading, so no page hydrated.
- Fix: `studio-loco:browser-buffer-package` plugin (client only, first in plugin order) resolves to the npm `buffer` package.
- Verified on the built Worker (wrangler dev): /app loaded live pools, wallet dialog opened on Enter and closed on Escape, homepage FAQ opened, bin explainer slider responded, no page errors. Hosted image paths 404 locally only (served by hosting).

## Pass 8 — pool detail SDK init (2026-10-06)
- Root cause 1: `package.json` has `"sideEffects": false`, so the production bundler dropped the side-effect-only `import "./polyfills"`; the SDK then hit `Buffer is not defined`. Fix: exported `installNodeGlobals()` called explicitly before the lazy SDK import; a failed SDK import resets so Retry re-evaluates it.
- Root cause 2 (exposed once the SDK ran): PublicNode answers 403 "Request blocked" to `getMultipleAccounts` with >10 keys (10 → 200, 11 → 403, verified). The relay splits those into ≤10-key requests (max 100 keys), merged in order; any failed chunk fails the whole call. Default mainnet upstream only.
- Verified on the built Worker (wrangler dev) in a browser, SOL-USDC 5rCf…HAS6: 80 real bins, active bin −5292 at 120.467 USDC/SOL, bin step 4 bps, SOL 9 decimals / USDC 6, reserves, mode Undetermined; read-only quote 0.1 SOL → 12.036704 USDC, minimum 11.97652, fee 0.000038944 SOL, impact 0.00%. All relay calls 200, no page errors. Not yet verified on the live site.

## Dispatch (SOL/USDC round-trip agent) — 6 Oct 2026
- [x] Unit tests: src/test/arb.test.ts (9) — precision/u64, orientation, duplicate pool, partial fills, leg-B funding bound, floor, unknown-fee block, no fee double-count, realized deltas.
- [x] Live read-only scan (mainnet, server RPC): 4 exact WSOL/USDC pools verified on chain, 12 ordered routes quoted; best expected net -0.001966518 SOL on 0.1 SOL -> correctly "no profitable route".
- [x] Composed atomic tx: 984 B (existing token accounts) / 1043 B (both created) <= 1232; programs limited to ComputeBudget, System, Token, ATA, DLMM; exact-message simulation err=null, 67,687 CU (third-party funded fee payer, sigVerify off; nothing signed).
- [x] Production build in the Worker engine: /app/dispatch 200, nav link, Scan once -> 12 routes, monitor start/pause, input validation, no page errors.
- [ ] Funded mainnet signature with a real wallet - not performed.
- [ ] Approval-time identity change / rejection / simulation-failure paths are covered by shared runner tests, not exercised with a real wallet on this page.

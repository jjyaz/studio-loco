# Release readiness

## Wallet Checks and The Replay Room

The published application update adds shared wallet lifecycle guards, a devnet memo rehearsal, fresh genesis status and historical rule replay. Automated validation passed: 209 tests across 20 files, source and QA-harness TypeScript, and a production build. Historical loading, playback, exports, outage recovery and mobile layout passed QA. Public desktop (1348px) and mobile (390px) checks passed on the deployed update. A funded devnet memo confirmed with an exact 5,000-lamport fee; this is separate from user browser-wallet approval. Browser QA and publication are recorded in `docs/qa/wallet-replay-release-validation.json`. Browser-wallet signing and a funded mainnet pilot remain user-run checks. See [the acceptance procedure](WALLET_REPLAY_RELEASE.md).

## Previous Observatory funded release

The Observatory passed funded devnet acceptance: six 20/21-bin × Spot/Curve/BidAsk native moves, exact 25% share withdrawals, preserved WSOL and six confirmed position cleanups. There are 27 confirmed transaction receipts including setup and no unresolved signatures. Funded mainnet signing and a browser-wallet rehearsal remain unperformed. The verified application commit `b8a11bd7` is published at [The Observatory](https://studioloco.cfd/app/agents). Production desktop routes, hydration, real watch-only positions and RPC/program reads passed; mobile QA passed separately in Lovable dev runtime. See [the release procedure](OBSERVATORY_RELEASE.md) and the machine-readable evidence in `docs/qa/`.

| Item | State | Evidence |
|---|---|---|
| Source + QA harness TypeScript | Pass | `npx tsc --noEmit -p .` and `npx tsc --noEmit -p scripts/qa/tsconfig.json`, 0 errors |
| Unit tests | Pass — 172 tests, 14 files | Complete suite; machine-readable results captured, not inferred from exit status |
| Production build (`npm run build`) | Pass — exit 0 | Client and Cloudflare Worker outputs generated |
| Native mainnet rebalance, read-only | Pass for Spot, Curve and BidAsk at 46 bins | Exact simulation plus decoded position range, owner and pool; even width retained |
| Curve native rebalance at 69 bins | Slippage refusal recorded | Two attempts returned protocol `ExceededAmountSlippageTolerance` (6003); signing remained blocked |
| Earlier route/layout audit, WebGL disabled, 390 / 768 / 1280 px | Pass in earlier audit; not rerun this pass | 17 routes × 3 widths, 0 page errors, 0 document horizontal overflow; terminal table scrolls inside its own frame |
| Hero art | Pass in earlier audit | Train and field visible at 390 and 1280; headline on clean sky |
| Live pool list, real bins, limit-order mode detection | Pass | YZY-USDC active bin −124, mode Undetermined → order-capable per SDK |
| Wallet absence | Pass | every action shows Connect wallet; nothing auto-transacts |
| Keyboard focus, wallet modal, dialogs | Pass (pass 5, /app at 1280px) | Skip link first; nav, Settings, Connect wallet, tabs, Refresh, inputs all show focus (search via amber frame); Enter opens wallet dialog, Escape closes it; 0 page errors |
| Funded devnet native acceptance | Pass — six cases, 27 confirmed transactions | Exact range/width/owner, 25% per-bin shares, WSOL account preservation and cleanup; zero pending signatures |
| Funded mainnet signing and native orders | **Not run** | No funded mainnet transactions or native-order signatures in this pass |
| Current preview runtime and UI | Pass in Lovable dev runtime | Five routes at 1280/390 px; no page errors/document overflow; wallet dialog, practice proposals/monitor/review, exact Apply→Arm→Disarm and real watch-only positions with spending blocked |
| Public release of this update | Pass — published and browser-verified | Commit `b8a11bd7`; six production routes, wallet modal, practice opt-in, 10 real watch-only positions and RPC/program reads; [evidence](qa/production-verification.json) |
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

### Corrective pass (review of 7e60d5b) — 6 Oct 2026, 22:06 UTC
- [x] Shared runner: optional `semanticGuard` checked before simulation, before wallet prompt and AFTER approval before persisting/broadcast (signed bytes discarded); `maxFeeLamports` re-reads getFeeForMessage for the fresh message and blocks on null/error/increase before signing.
- [x] Dispatch guard binds a monotonic generation (bumped on wallet/cluster/RPC/practice/config change, hide, unmount — no ABA), practice state, full config key and Date.now() quote age (20 s).
- [x] Monitoring pauses during review/signing; an unresolved round-trip signature blocks new reviews/approvals until reconciled.
- [x] One `validateConfig` for storage, import, form and every disabled state: version, unknown keys, integer/finite/bounded numerics (interval 30–600 s, default 60), exact decimals, u64.
- [x] Review: exact getFeeForMessage for the actual message (incl. priority; base/priority split for display only), wallet-specific rent (existing accounts not charged), final tx rebuilt with the enforced floor and fee re-checked; balance check. Rent-only-failing scan routes can be re-reviewed.
- [x] Scan: RPC-estimated fee labelled as estimate; old results cleared on any input change; partial scans say "insufficient evidence"; discovery rejections shown.
- [x] WSOL ATA to be closed is created with the non-idempotent instruction (fails if it appeared after our read); pre-existing ATAs decoded (mint/owner/initialized/frozen/close authority) and never closed.
- [x] Fee mint per leg from SDK fee mode, protocol share shown, never subtracted twice; receipts show UNKNOWN for missing/unsafe metadata.
- [x] Tests: 93/93 (`src/test/arb.test.ts`, new `src/test/arb-guards.test.ts`: expiry/ABA/practice during approval, pre-sign guard, fee null/error/increase, sim failure, rejection, composition order + encoded amounts, no intermediate close, strict vs idempotent create, floor, bindings, reversed orientation, oversize, receipts). Typecheck clean; `vite build` exit 0.
- [x] Built Worker (wrangler dev, server RPC override): /, /app, /app/dispatch 200, unknown 404; relay getGenesisHash = mainnet. Browser: live scan 4 pools / 12 routes, best -0.002024791 SOL on 0.1 SOL → "no profitable route"; monitor start/pause; invalid input disables Scan and clears results; 10 s interval disables Start; no page errors; no horizontal overflow at 390 px and 1280 px.
- [ ] Not exercised: review/approval with a real connected wallet (none available headless), funded signature. No funds used.

### Lifecycle fix (review of 69f63bb) — 6 Oct 2026, 22:15 UTC
- [x] Scan/requote share a synchronous single-job lock (`JobControl`); requote stops monitoring and cancels scans first; Scan/Start disabled while reviewing, a review exists, the runner is busy or a request is draining.
- [x] Every requote await (SDK pool load, refetchStates, verification, wallet reads, quotes, builds, fee reads) and scan rent/fee/scan reads is bounded and re-checks generation/abort/mounted afterwards; obsolete success/error/finally updates are suppressed.
- [x] Pause, tab hide, config/identity change and unmount bump the generation, abort the job and clear reviews immediately; a timed-out request keeps a drain latch until it settles (UI shows Draining).
- [x] Reset resets the form draft as well as saved config.
- [x] Tests 101/101 (new `src/test/job-control.test.ts`, 8 tests against the real controller); typecheck 0 errors; `vite build` exit 0. No browser re-check of this pass; no funds used.

## Liquidity Agents (/app/agents)
- [x] 128/128 tests (incl. src/test/agents.test.ts), tsgo typecheck clean, production build exit 0.
- [x] Browser (dev): no-wallet empty state, practice scenario rule→arm→proposals→practice review at 1280px and 390px; no page errors, no horizontal overflow.
- [x] Live native rebalance built + simulated using a real public mainnet position and sigVerify disabled; decoded post-state checked. No signing or ownership claim.
- [x] Funded signed devnet rebalance / withdrawal (six cases, confirmed 2026-10-07; mainnet signing remains unperformed).
- Historical limit, superseded below: SDK 1.9.14's convenience balanced helper adds one bin to even-width ranges. The explicit SDK strategy path now preserves the original width.

### Liquidity Agents review fixes (2026-10-07)
- [x] 165/165 tests, clean TypeScript check, production build exit 0 and clean diff whitespace. React integration tests cover stale reads after rule edits, fresh arming, per-position volatility, short pauses, persisted pending signatures and cancelled preparation.
- Rules invalidate running checks/builds immediately. Arming fetches a new chain baseline; edits cannot restore old armed rules. Closing preparation cancels it.
- Cached pool state is refreshed on every indexed observation. Volatility is scoped by position and full metric; future, duplicate and gapped candles are rejected.
- Pausing, hiding, reviewing and rule/identity changes reset observed-time continuity. Paused manual checks do not accrue monitoring time. A risk trigger in cooldown cannot fall through to a rebalance.
- Approval and the runner share the same readiness guard: finite known fees, balance, upfront SOL, successful exact simulation, valid size/compute, frozen scope and TTL. Pending signatures are checked from persistent storage at execution time.
- Correct SDK boundaries: numeric deposit offsets; net wallet input must be zero; gross redeposit and net wallet output shown separately. Both native rebalance and withdrawal preserve existing WSOL. Active-bin slippage rounds down and honors zero.
- Original SDK/RPC promises are tracked by JobControl, including after timeout. Multi-transaction percentage withdrawals are rejected before signing to prevent repeating the first chunk. Native bin-account preflight may still be reviewed separately and followed by a fresh rebalance build.
- Staged moves verify the destination's exact mint pair on chain and show its orientation, distribution and capped range width before withdrawing.
- Read-only mainnet proof: an actual 25% withdrawal of a public SOL/USDC position simulated successfully (751 bytes, 297759 CU, 5000-lamport fee); no signature or broadcast. Same-pair discovery returned 40 valid pools; 12-candle 5m volatility was available. Even-width native rebalance correctly refused a changed width. Odd-width native instruction construction timed out; live native rebalance remains unverified.
- Browser preview blocked in this session; screen behavior verified with React integration tests. Funded rebalance/withdrawal acceptance remains outstanding. This pass does not publish the site.

### Native acceptance preparation (2026-10-07)
- [x] Explicit SDK strategy construction replaces the convenience balanced helper. Target width is exactly `upper - lower + 1`, including even widths. A changed active-bin snapshot and zero gross redeposit are refused.
- [x] Review expiry starts after all preparation and simulation finish; the visible UI clock updates immediately. A 25-second mocked build still receives a fresh 20-second window, and the execution guard refuses it after expiry.
- [x] Native SDK instruction composition has a 45-second bound; individual wallet-provider RPC requests bound headers and response bodies at 15 seconds and disable automatic 429 retries. JobControl continues tracking underlying work until it drains.
- [x] Mainnet even-width Spot: 901 bytes, 488807 CU. Curve: 901 bytes, 488974 CU. BidAsk: 901 bytes, 485851 CU. Each had a 5000-lamport exact network fee, kept 46 bins and verified the simulated position's owner and pool. These are unsigned simulations, not funded receipts.
- [x] Curve amount-slippage failures are retained in the evidence. No tolerance was loosened and no failed simulation was signed.
- [x] Dedicated signed-devnet harness verifies genesis/program, creates a synthetic-token pool, covers 20/21-bin Spot/Curve/BidAsk native moves, 25% per-bin share withdrawals and explicit cleanup through the shared runner. Persistent unknown signatures stop a rerun. At this preparation stage, the harness passed compilation and funding preflight only. The signed matrix subsequently passed below.
- [x] Fund the dedicated QA wallet, run the signed matrix and verify all confirmed receipts — completed in the acceptance pass below.
- [x] Verify preview behavior and publish only after funded acceptance passes, then re-check the production routes and relay — completed below.
- Current browser preview check redirects to Lovable sign-in. No authentication or browser wallet rehearsal was performed. An attempted local Worker smoke check could not start Wrangler in this environment (`uv_interface_addresses` system error); successful production bundling does not count as a runtime smoke pass.

### Confirmed funded acceptance (2026-10-07)
- [x] User funded the dedicated devnet QA wallet with 0.5 test SOL. The first setup and pool creation confirmed, then the next simulation blocked because the SDK's default pool-creation helper had unwrapped the existing WSOL account. [That failed attempt](qa/funded-devnet-setup-refusal.json) is retained; no position was signed in that attempt.
- [x] Harness setup now explicitly preserves WSOL and resumes the same verified pool/mint with re-verified setup receipts. The successful run restored the WSOL fixture and completed all six cases. [Full confirmed receipts and post-state evidence](qa/funded-devnet-acceptance.json).
- [x] Six native rebalances, six exact 25% share withdrawals and six full withdrawal/close cleanups confirmed. Every native move retained its 20/21-bin width, target range and owner. Existing WSOL survived. All six positions were closed and no unresolved signature remained.
- [x] 27 confirmed transactions including reused setup receipts, 170000 lamports total network fees. Final unwrapped devnet SOL balance: 326215840 lamports. WSOL and setup pool/token/bin accounts remain test fixtures; the balance difference is not described as network fees alone or a full rent refund.
- [x] Lovable read-only QA of commit ead532a0: `/`, `/app`, `/app/agents`, `/app/dispatch`, `/docs` returned 200 at 1280 and 390 px, no page errors/document overflow. Connect wallet opened on Enter and closed on Escape; invalid watch address blocked Inspect; explicit practice rules, arm, monitoring start/pause, proposal review and Close worked. Follow-up confirmed Apply→Arm→Disarm at both sizes; the earlier loose locator had clicked the position card. Real mainnet watch-only loaded eight verified positions and kept spending controls disabled. No wallet was connected. [Full scoped QA findings](qa/preview-ui-verification.json).
- [x] Publish the verified build and verify production routes, hydration and relay behavior — completed below.

### Public production verification (2026-10-07)
- [x] Published application commit `b8a11bd71c729c7e34779f3a56b9184cc5107b02` through the existing Lovable project; deployment request `72ffd53e-7d9e-449f-b100-f03de0111db2`. The deploy response was pending, followed by successful normal-browser verification on [studioloco.cfd](https://studioloco.cfd/app/agents).
- [x] `/`, `/app`, `/app/agents`, `/app/dispatch`, `/docs` and `/network` rendered in production at desktop widths without document overflow. The live docs contain this release's six-case/27-receipt acceptance statement. Keyboard wallet dialog and explicit practice Run check proved hydration. With no wallet, real action checks/monitoring remain disabled.
- [x] Production watch-only loaded 10 real mainnet SOL/USDC positions, real active-bin/range/holdings state and same-pair pool comparisons. Both staged-move buttons were disabled. No wallet was connected and nothing was signed or broadcast.
- [x] Status showed confirmed slot 454359334, block height 432396837 and an executable DLMM program account. Meteora Data API was OK. The status UI does not expose the genesis hash, so a direct production genesis lookup is not claimed.
- [x] Captured error-level console entries contained no application errors; 27 unrelated browser-extension metadata errors were identified by their extension URL. This is a console audit, not a separate pageerror listener. Raw CLI GET probes were refused (403/code 1010); the normal browser worked, and no client bypass was attempted.
- [x] [Machine-readable production evidence](qa/production-verification.json) and [live screenshot](qa/observatory-live-release-1791412927834.jpg) retained. Production mobile and connected browser-wallet signing were not rerun; the existing mobile dev-runtime check and funded devnet Node-runner checks are reported separately.

## Signal Box + Flight Recorder — 8 Oct 2026
- Scheduler: one job every 5 min (288 runs/day) POSTs the token-protected tick hook on the preview host. Hook was 404 on the hosted preview during this pass (preview not yet redeployed); local runs passed.
- Worker evidence (real mainnet, real DB, temporary watch-only position 1Be6…44id): tick 1 → observation (active −5444, out of range) + 1 alert `left-range`, push "inbox only"; tick 2 → observation, 0 alerts (deduped by cooldown). Stale-revision commit refused ("revision changed"). Lease: second holder refused.
- Isolation: another account sees 0 watches/alerts/observations and cannot delete; owner sees own rows; anon reads [] and cannot call commit.
- Browser E2E (local, temporary confirmed account, then deleted): sign-in, verified watch created and armed, pause → rev 2, health table, notifications blocked state shown honestly; 1280/390 no overflow, no page errors.
- Not yet verified: two scheduled hosted ticks after browser close; real Web Push delivery to a device; wallet signing/mainnet (user-run).

# Release readiness

| Item | State | Evidence |
|---|---|---|
| Typecheck (tsgo) | Pass | no errors |
| Unit tests (vitest) | Pass — 23 tests | `src/test/core.test.ts`: amount parsing, strategy normalization, route import/export/share, bin math, range state, tx runner success / simulation failure / onchain failure / blockhash expiry / rejection + partial sequence, API 429 retry & HTTP error, practice data, lab tallies & commitments |
| All routes render (Chromium, WebGL disabled) | Pass | /, /app, /app/pool/:address, portfolio, studio, signals, launch, lab, lab/architecture, network, governance, token, docs, journal, journal/:slug, 404 |
| Live pool list from Meteora API | Pass | terminal screenshot |
| Real bins via SDK + relay RPC | Pass | YZY-USDC rail map, active bin −124 |
| Real swap quote via SDK | Pass | 10 YZY → 2.88 USDC, min received at 0.5% |
| Wallet absence | Pass | actions show Connect wallet; nothing auto-transacts |
| Failed API | Pass | explicit error + Retry; no substitute data |
| Practice mode | Pass | opt-in, banner, non-transactable addresses |
| Funded wallet signing (swap, add, claim, withdraw, close, createLbPair2) | **Not yet run** | requires a funded wallet + human approval |
| Native limit orders | **Not implemented** | handoff only |
| Confidential protocol | **Not deployed** | educational simulation only |

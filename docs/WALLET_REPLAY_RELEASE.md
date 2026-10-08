# Wallet acceptance and historical rule replay

This release adds `/app/checks` and `/app/replay`, hardens the shared wallet lifecycle, and exposes fresh genesis verification on `/network`. Existing native DLMM execution builders and funded devnet receipts are unchanged.

## Wallet lifecycle

- A browser-wide transaction slot spans routes and mounted runner instances. Concurrent wallet actions wait until the original approval or settlement resolves. This is a single-tab guard; it does not coordinate separate browser tabs or other applications.
- Changing wallet, cluster or RPC invalidates the initiating runner even if the setting is changed back. Leaving the initiating page discards an approval returned before broadcast. A transaction already broadcast continues confirmation and retains its public pending record until settlement is resolved.
- Any unresolved signature for the same wallet and cluster blocks a fresh action, even after an RPC change or reload. Check status never resends the transaction.
- Wallet Checks reads a fresh genesis hash and current confirmed slot. The devnet-only rehearsal builds one official Memo instruction, checks executable program, exact fee and balance, simulates the exact message, then opens a 20-second review. No token transfer or account creation occurs; the approved devnet network fee is real.
- The rehearsal uses the existing shared simulate/sign/message-verify/broadcast/confirm runner. Fee cap and freshness are rechecked before and after approval. Mainnet rehearsal requests are refused before RPC access.
- Header and response-body deadlines now cover the Meteora Data API even when a fetch implementation ignores abort. Real parse failures stay distinct from timeout and cancellation.

## The Replay Room

- Historical mainnet tapes contain completed Meteora candles: 288 five-minute periods or 168 hourly periods. The API rejected these full windows in the first browser pass. The loader now fetches sequential windows of at most 96 periods, validates each half-open partition and stitches the tape without double-counting inclusive boundary rows. Empty partitions remain missing history; a failed partition stops the complete load. The whole load has a 40-second deadline. The first available close initializes the modeled range and baseline.
- Strict parsing refuses malformed prices, nonaligned times and duplicate timestamps. Missing periods and excluded outside-window periods remain visible. API errors never substitute a practice fixture.
- Observatory rule evaluation uses only the prefix available at each completed close. Cooldowns and risk precedence are preserved. Observed out-of-range duration resets across gaps; volatility needs consecutive closes and a matching frame.
- Bin IDs are inferred from Y-per-X candle prices, bin step and both token decimals. They are not historical on-chain active-bin observations.
- Metrics are close samples in range, intrabar extrema outside a modeled range, proposals and hypothetical moves. They are not continuous time in range or investment performance.
- Optional modeled rebalances freeze a target at a close and apply it before the next observation. No real execution, approval delay, slippage, token allocations, trading fees, rewards, impermanent loss or profit is reconstructed. Risk withdrawals remain proposals.
- Spot, Curve and BidAsk templates show different widths and illustrative distributions. Distribution alone cannot change geometric coverage at the same width.
- Playback is user-started and pauses when the document is hidden. A keyboard-accessible slider inspects decisions. JSON export includes exact candles, source, window, quality, configuration, assumptions and decisions.

## Automated evidence

`docs/qa/wallet-replay-unit-results.json` records 209 passing tests across 20 files, zero failures. The focused additions exercise real shared-runner code with a mocked adapter/RPC, strict tape parsing, causal replay, exact widths, cooldown, gap continuity, mismatched volatility, historical-error boundaries and cancellation of late results. These tests do not constitute real browser-wallet acceptance or funded mainnet transactions.

The initial browser failure is retained in `docs/qa/wallet-replay-preview-first-pass.json`; repaired historical loading and recovery require a second browser pass. Source TypeScript, QA-harness TypeScript, production build and browser results are recorded separately in `docs/qa/wallet-replay-release-validation.json` as they are completed.

## Manual browser-wallet acceptance

Use a wallet you control on devnet at `/app/checks`. The application never requests a seed phrase or private key.

1. Verify devnet genesis and signing capability. Prepare a rehearsal and compare the displayed fee/payer with the wallet prompt.
2. Decline. Expect a rejected outcome, no broadcast and no pending signature.
3. Expire a review. Prepare it again; the old approval cannot be reused.
4. With the prompt open, switch wallet, cluster or RPC, or leave the route. A returned approval must be discarded before broadcast, including away-and-back changes.
5. Approve a fresh rehearsal. Verify the confirmed explorer receipt and memo; only then record browser acceptance as passed.
6. For an unknown settlement, reload. Confirm that public pending metadata returns and Check status reconciles without resending. Never fabricate a receipt to mark this check passed.

## User-approved mainnet pilot

After browser acceptance, open one existing position owned by the connected wallet in The Observatory. Choose the pilot position and amount yourself. Review target bin endpoints, exact original width, selected strategy, zero token top-up, known network fee, upfront rent and sufficient native SOL. Prepare and simulate from fresh state, then personally approve in the wallet within the frozen review window. If simulation refuses slippage or costs are unknown, keep signing blocked rather than weakening limits.

Verify confirmed settlement, resulting owner/pool/range, remaining assets and preserved WSOL account. Record public signature and observed post-state in a pilot report. Funding alone, an unsigned simulation or a mocked adapter is not a completed mainnet pilot. No new mainnet transaction was signed in this release work.

This remains ordinary Meteora DLMM. DLMM Pro, background keepers and auto-signing are not introduced.

## Sources

- [Official Solana Memo client](https://github.com/solana-program/memo/blob/main/clients/js-legacy/src/index.ts)
- [Official Meteora DLMM Data API overview](https://github.com/MeteoraAg/docs/blob/main/developer-guides/dlmm/api-reference/overview.mdx)
- [Prior funded native acceptance and release](OBSERVATORY_RELEASE.md)

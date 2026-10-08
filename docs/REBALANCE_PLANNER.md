# Rebalance Planner and Flight Recorder

Open the Observatory, connect a wallet or inspect a public address, and run a position check. Select a position and use its Rebalance Planner to compare four choices:

| Choice | Behavior | Cost evidence |
|---|---|---|
| Stay put | No transaction, no changed range | Zero transaction cost |
| Recenter | Preserve the exact source width around the active bin | SDK amounts/rent and unsigned exact-message simulation |
| Widen | Explicit integer bounds containing the current range, up to 69 bins | SDK amounts/rent and unsigned exact-message simulation |
| Move pools | Verify the exact two mint addresses, then withdraw liquidity and separately add at the destination | Withdrawal simulation only; destination amounts are estimates and destination costs stay unpriced |

The network fee, conservative upfront SOL requirement and net simulated SOL outflow have different meanings. Rent quotes may include refundable position rent and non-refundable price-level accounts. Split native operations show only the account-creation step's exact costs; their later rebalance is rebuilt after confirmation. A pool move leaves unclaimed fees/rewards in the original open position and does not enforce a withdrawal output floor. No quote guarantees realized returns or final balances.

Each comparison saves a new immutable Recorder parent with one linked factual record per option. Selecting a route creates another record, followed by a freshly rebuilt review and shared-runner wallet evidence. A confirmed pool withdrawal opens a fresh destination add form, preserving links through its review and wallet action. The destination form never signs or deposits an imported amount automatically. Recorder's Connected evidence links show these relationships; reload, export/import and optional private cloud sync use the existing v1 format.

Planning uses public chain reads and unsigned simulations. Watch-only addresses can compare and record a stay-put decision but cannot request a wallet action. Practice is explicitly separate and does not substitute fixtures for failed chain reads. Exact raw token amounts and mint addresses are available beneath each option.

Wallet/network/RPC, position/range/active-bin, strategy, slippage, source rule, applied private-watch revision and assumption edits invalidate comparison input identity. Comparison snapshots expire after 120 seconds. Reviews start their 20-second window after the fresh build finishes, retain exact fee caps and recheck semantic identity before and after wallet approval. A current private watch is verified before signing and again after approval; unavailable or changed rules stop broadcast. JobControl keeps timed-out requests draining instead of allowing overlapping work.

Cost recovery arithmetic uses only the user's recorded SOL/day fee assumption and complete simulated SOL outflow. Incomplete staged costs suppress the estimate. It is an assumption-based calculation, not an APY, PnL, fee-growth or profit forecast.

Run `npm test -- --maxWorkers=2`, source and QA-harness TypeScript checks, and `npm run build` for automated validation. The Planner adds range/identity/Recorder tests, watch-only and persistence-race UI checks, exact widening/no-top-up regressions and private-watch approval checks. Actual browser-wallet acceptance and funded execution of this update remain separate user-run checks. Ordinary DLMM is integrated; DLMM Pro is not claimed by this release.

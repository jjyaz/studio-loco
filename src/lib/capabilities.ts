/**
 * Capability registry — the single source of truth for what is real.
 * status:
 *  live          backed by real chain / public API data and real SDK transactions
 *  simulation    local, illustrative computation; never presented as onchain
 *  handoff       documented configuration only; adapter not implemented
 *  not-deployed  requires a program / protocol that does not exist yet
 */
export type CapStatus = "live" | "simulation" | "handoff" | "not-deployed";

export interface CapabilityEntry {
  id: string;
  area: string;
  name: string;
  status: CapStatus;
  notes: string;
}

export const CAPABILITIES: CapabilityEntry[] = [
  {
    id: "switchyard",
    area: "Observatory",
    name: "The Switchyard · prospective shadow range policies",
    status: "live",
    notes:
      "Fresh ordinary-mainnet DLMM LP account observations compared with sealed stay, recenter and inclusive-widen range policies. Coverage counts retained observed samples against the range before the next hypothetical decision; it is not time in range. Immediate post-recording settlement is assumed; token inventory, swaps, latency, slippage, fee income and PnL are not modeled. Gaps suppress first-reset actions and remain unknown. Explicit per-proposal network-fee assumptions exclude rent and are not actual costs. Durable CAS and immutable source/policy/history; 20 experiments, 360 retained scored observations each, omissions disclosed. Local Recorder copies and source Journey/Continuity links; current local decisions only can hand off to fresh Planner reads/simulations/approval, with intent freshness and retained-scope checks before and after wallet signing. Strict supplied-only imports; SDK 0.4.0/local MCP analysis, no hosted private-history access, background observer or Pro execution. Funded Journey lifecycle acceptance remains user-run.",
  },
  {
    id: "journey-continuity",
    area: "Observatory",
    name: "Journey Continuity · linked strategy lifecycle",
    status: "live",
    notes:
      "Persistent local Foundry strategy identity across verified deposits, rebalances, fee/reward claims, withdrawals, native order cancellations and closures. Shared-runner public instruction facts are candidates, not confirmations; exact installed-IDL signer/target/pool roles and fresh resulting-account identity are independently checked. Pool moves retain locally reviewed destination intent, separately verified source/deposit receipts, pending/interrupted state and fresh wallet reviews after reload. Strategy association is device evidence, not proof tracing fungible capital. Original and staged/closure receipts are pinned within 200 retained chapters; 50 strategies and 20 accounts/moves per strategy. Atomic CAS and immutable retained history; strict 10 MB supplied-evidence import/export. SDK 0.4.0 and opt-in local-only MCP inspection; no public device-history API, signing or Pro execution. Before/after observations are non-atomic and not PnL. Funded Foundry-to-continuity lifecycle acceptance remains user-run.",
  },
  {
    id: "journey",
    area: "Observatory",
    name: "The Journey · verified strategy accounts and observed timeline",
    status: "live",
    notes:
      "Confirmed local Foundry receipts are independently linked through transaction signer/instruction/account verification, exact saved blueprint digest/revision and fresh mainnet account reads. Explicit watch-only accounts never imply blueprint creation. Verified program/discriminator/pool/owner/mints, slot monotonicity and byte corroboration across SDK multi-reads. LP holdings, per-bin shares, range state, claimed and unclaimed fee counters; native resting/partial/fulfilled and removed/reset levels. Read intervals are not exact execution timestamps. Missing accounts are unavailable, never inferred closed/filled. Durable device storage with cross-tab CAS, bounded snapshot/timeline retention and JSON evidence export. Linked action network fees, current account lamports and rent minimum separated; no inferred PnL. Five-minute private hosted range/order watches, seven-day expiry, existing lease/CAS/RLS and optional push; gaps reset order baseline. Planner and order handoffs require fresh reads and wallet reviews. Pro remains disabled.",
  },
  {
    id: "strategy-foundry",
    area: "Foundry",
    name: "Versioned liquidity blueprints, custom weights and native order ladders",
    status: "live",
    notes:
      "Append-only device revisions with SHA-256 integrity and concurrent-write protection; strict JSON import/export. Ordinary mainnet DLMM only. Fresh genesis/program/pool/mint/clock checks, verified current base/variable fee and fee currency, custom native 16-bit weighted deposits and pool-gated native buy/sell ladders. One atomic transaction per review; simulation verifies the target account, exact position bounds or ladder side/levels/raw amounts. Fees, SOL top-up, rent and temporary WSOL upfront funding are checked; existing WSOL is preserved. 20-second reviews, monotonic edit and identity guards before/after wallet approval, current pool revalidation and shared runner confirmation. Blueprint revision/digest link reviews and receipts in Flight Recorder; no inferred PnL, background keeper or imported transaction authorization. SDK/MCP inspection is read-only and does not access device libraries. Pro remains unverified and disabled. Funded mainnet signing remains a user-run acceptance check.",
  },
  {
    id: "developer-sdk",
    area: "Developers",
    name: "Loco SDK, read-only API v1 and MCP",
    status: "live",
    notes:
      "Versioned installable ESM SDK with declarations, runtime validation, bounded cancellable reads; public mainnet Meteora-index pools and confirmed PositionV2/pool snapshots with genesis, program, discriminator, pool and mint checks. Official MCP v2 hosted Streamable HTTP + stdio; seven public read-only tools. Local range geometry is not native simulation. Recorder schema shared with the SDK; aggregate export analysis runs locally, opt-in in stdio and absent from hosted MCP. No signing, generic RPC, private cloud reads, profit forecasts or DLMM Pro. Direct versioned package distribution; not on the npm registry.",
  },
  {
    id: "pool-list",
    area: "Terminal",
    name: "Pool list, search, sort, pagination",
    status: "live",
    notes: "Meteora data API, mainnet only.",
  },
  {
    id: "practice",
    area: "Terminal",
    name: "Practice mode",
    status: "simulation",
    notes: "Seeded fictional pools; explicit opt-in; not transactable.",
  },
  {
    id: "wallet",
    area: "Wallet",
    name: "Phantom / Solflare via wallet adapter",
    status: "live",
    notes: "No key custody, no emulation.",
  },
  {
    id: "rail-map",
    area: "Pool",
    name: "Rail Map of real bins",
    status: "live",
    notes: "SDK getBinsAroundActiveBin via user RPC.",
  },
  {
    id: "add-liq",
    area: "Pool",
    name: "Add liquidity by strategy",
    status: "live",
    notes:
      "initializePositionAndAddLiquidityByStrategy, ephemeral position keypair in memory only; ≤69 bins.",
  },
  {
    id: "swap",
    area: "Pool",
    name: "Direct pool swap",
    status: "live",
    notes:
      "swapQuote + swap; quote bound to amount/direction/slippage/cluster/RPC/wallet, 20s expiry; confirmation-gated success.",
  },
  {
    id: "tx-runner",
    area: "Wallet",
    name: "Transaction runner",
    status: "live",
    notes:
      "Requires wallet signTransaction (no sendTransaction fallback); genesis-hash cluster check before signing; identity re-checked after approval; exact-message simulation; signed-bytes check; every status/height call time-bounded; persisted unresolved signatures with Check status; no automatic resend.",
  },
  {
    id: "orders",
    area: "Pool",
    name: "Native limit orders",
    status: "live",
    notes:
      "SDK isSupportLimitOrder gate; quoteCreateLimitOrder, placeLimitOrder (ephemeral order signer), mainnet discovery via Meteora indexed open orders (paged, capped 5×50) with on-chain program/discriminator/pool/owner verification and SDK getLimitOrder; devnet/custom RPC use the SDK scan. cancelLimitOrder + closeLimitOrderIfEmpty. Built and simulated; not yet signed with a funded wallet.",
  },
  {
    id: "portfolio",
    area: "Portfolio",
    name: "Positions, fees, rewards",
    status: "live",
    notes:
      "Mainnet: Meteora indexed portfolio, every position verified on chain (program, PositionV2 discriminator, pool, owner; ≤100-account reads), drops/truncation shown; watch-only read mode. Devnet: SDK scan.",
  },
  {
    id: "dispatch",
    area: "Dispatch",
    name: "SOL/USDC two-pool DLMM round-trip agent",
    status: "live",
    notes:
      "Mainnet only. Exact-mint discovery (top ≤5 TVL pools), on-chain pool/mint/token-program checks, SDK swapQuote both legs (leg B input = leg A minimum), exact BN cost floor; unknown costs block. One atomic legacy tx (strict create for a temporary WSOL ATA, idempotent USDC create, single wrap, no mid-route unwrap, temp WSOL closed only if created here) via the shared runner with a semantic guard (generation, config, practice, 20 s quote age) before and after wallet approval and an exact getFeeForMessage cap; monitoring pauses during review; unresolved signatures block new runs. Read-only scan + in-tab monitoring verified on live mainnet; composed tx simulated OK with a third-party fee payer (sigVerify off, never signed). Not yet signed with a funded wallet. DLMM Pro not integrated.",
  },
  {
    id: "agents",
    area: "Agents",
    name: "Liquidity Agents · rules, proposals, reviews",
    status: "live",
    notes:
      "Verified fresh positions and arming baselines, per-position volatility, visible in-tab monitoring, risk-first cooldown and strict local rules. Edits cancel work and stale proposals. Frozen reviews get 20s AFTER preparation and simulation, with guards before+after wallet approval. Unknown balances/costs, failed simulation and unresolved signatures block. Native explicit SDK strategies preserve exact odd/even widths and zero net token top-up; SOL fees/rent still apply. Gross redeposit is separate; existing WSOL is preserved. Live mainnet Spot, Curve and BidAsk passed with 46 bins, including decoded range/owner/pool post-state. Two 69-bin Curve attempts hit protocol amount-slippage refusal and stayed unsigned. Real 25% withdrawal simulation also passed. SDK instruction composition is bounded at 45s; individual RPC headers+body at 15s, with no automatic 429 retry. Multi-tx Agent withdrawals blocked before signing; staged moves verify mints and disclose width caps. Funded devnet acceptance passed six 20/21-bin Spot/Curve/BidAsk native moves, exact 25% share withdrawals, WSOL preservation and cleanup: 27 confirmed receipts, zero pending. No funded mainnet signing or browser-wallet rehearsal. Practice/watch-only cannot transact. Ordinary DLMM, no DLMM Pro or background keeper. See docs/OBSERVATORY_RELEASE.md.",
  },
  {
    id: "claim",
    area: "Portfolio",
    name: "Claim fees / rewards",
    status: "live",
    notes: "claimSwapFee, claimAllRewardsByPosition.",
  },
  {
    id: "rebalance-planner",
    area: "Agents",
    name: "Rebalance Planner connected to Flight Recorder",
    status: "live",
    notes:
      "Watch-only and wallet comparisons of keep, same-width recenter, explicit wider range up to 69 bins, and verified same-mint staged pool moves. Unsigned native builds with exact first-transaction simulation, SDK token/rent amounts and network fee/SOL requirements. Missing or later-stage costs remain unpriced. Recovery arithmetic uses only a recorded user assumption and complete simulated SOL outflow; no APY or profit forecast. Immutable comparison, per-option and selection evidence links fresh reviews and shared-runner wallet actions, including a separate destination deposit. Inputs invalidate comparisons and reviews; 2-minute comparison expiry, 20-second reviews and exact fee caps. No signing in the planning phase; this update's wallet execution still requires user-run acceptance.",
  },
  {
    id: "withdraw",
    area: "Portfolio",
    name: "Withdraw % / remove & close",
    status: "live",
    notes: "removeLiquidity (bps, shouldClaimAndClose), closePosition.",
  },
  {
    id: "studio",
    area: "Studio",
    name: "Strategy composer previews",
    status: "simulation",
    notes: "Shape preview is illustrative; execution uses SDK semantics.",
  },
  {
    id: "studio-exec",
    area: "Studio",
    name: "Execute selected route",
    status: "live",
    notes:
      "v2 plans carry cluster + exact decimal X/Y amounts into the pool review; wrong-cluster plans are blocked; illustrative budget is never converted.",
  },
  {
    id: "signals",
    area: "Signals",
    name: "In-tab range watch",
    status: "live",
    notes: "Polls positions while open. No keeper.",
  },
  {
    id: "rebalance",
    area: "Signals",
    name: "Two-step rebalance plan",
    status: "live",
    notes:
      "Non-atomic: withdraw then add, each user-approved. removeLiquidity here enforces no minimum withdrawn amount; shown values are estimates.",
  },
  {
    id: "signal-box",
    area: "Signals",
    name: "Signal Box hosted watches",
    status: "live",
    notes:
      "Private mainnet watches; scheduled every 5 min, arb watches every 15 min, 7-day expiry, 5 watches/account including at most 1 arb. Lease-gated atomic commits, revision CAS, genesis/account/mint verification and bounded reads. Actual scheduled preview ticks 12/13 verified a public position, durable alert and cooldown with all clients closed. Inbox + opt-in account-linked Web Push; real-device delivery remains unverified. Identifier-only handoffs load current private rules and require a fresh check/scan and new wallet review; no hosted signing.",
  },
  {
    id: "recorder",
    area: "Signals",
    name: "Flight Recorder",
    status: "live",
    notes:
      "Shared-runner evidence in IndexedDB with optional RLS-private cloud copy and monotonic conflict protection. Reload and quota-failure recovery, scoped unresolved-signature reconciliation without resending, separately identified/sanitized imports. Receipt availability is explicit, unsafe numeric amounts omitted, no inferred PnL or position-state verification. Wallet evidence and unresolved actions are retained.",
  },
  {
    id: "fee-weather",
    area: "Signals",
    name: "Fee Weather",
    status: "live",
    notes: "Actual dynamic/base fees and activity from API. No predictions.",
  },
  {
    id: "launch",
    area: "Launch",
    name: "createLbPair2 wizard",
    status: "live",
    notes: "PresetParameter2 fetched onchain, duplicate check, simulation.",
  },
  {
    id: "dbc",
    area: "Launch",
    name: "DBC / DAMM v2 / Alpha Vault",
    status: "handoff",
    notes: "Documented only.",
  },
  {
    id: "lab",
    area: "Lab",
    name: "Ballot / sealed bid / histogram",
    status: "simulation",
    notes: "Web Crypto AES-GCM + SHA-256 commitments, single local key.",
  },
  {
    id: "confidential",
    area: "Lab",
    name: "Threshold FHE / committee / ZK",
    status: "not-deployed",
    notes: "Requires MPC/FHE network, verifier program, DA, audits.",
  },
  {
    id: "ohlcv",
    area: "Pool",
    name: "Price history",
    status: "live",
    notes: "Meteora mainnet OHLCV candles 5m–24h; no synthetic data.",
  },
  {
    id: "network",
    area: "Network",
    name: "Cluster & DLMM observatory",
    status: "live",
    notes:
      "Fresh genesis verification, RPC slot, block height, version and program account. Cluster mismatch refuses status reads; waits are bounded.",
  },
  {
    id: "replay-data",
    area: "Replay",
    name: "Historical mainnet candle tapes",
    status: "live",
    notes:
      "Completed Meteora OHLCV windows: 24h of 5m or 7d of 1h candles. Strict parsing, duplicate/malformed refusal, missing-period counts, explicit practice source. No error-to-fixture fallback.",
  },
  {
    id: "replay",
    area: "Replay",
    name: "The Replay Room · rule and range models",
    status: "simulation",
    notes:
      "Prefix-only Observatory rules, cooldown and risk precedence, inferred bin IDs, close-sample range coverage, intrabar extrema flags, template comparisons, playback and reproducible JSON export. Hypothetical next-observation rebalances are opt-in; risk withdrawals remain proposals. No measured fills, fees, impermanent loss or profit.",
  },
  {
    id: "wallet-checks",
    area: "Wallet Checks",
    name: "Connection verification & devnet rehearsal",
    status: "live",
    notes:
      "Fresh RPC genesis check, signing-capability and SOL-balance display; devnet-only exact memo simulation, known fee/balance, 20s frozen review, shared wallet runner and confirmed receipt. No token transfer or liquidity move. Browser wallet approval remains a user-run acceptance check, not proven by mocked lifecycle tests.",
  },
  {
    id: "ciphernodes",
    area: "Network",
    name: "Ciphernode operator network",
    status: "not-deployed",
    notes: "Separate future protocol.",
  },
  {
    id: "governance",
    area: "Governance",
    name: "Decision room",
    status: "simulation",
    notes: "Local proposals only. No DAO.",
  },
  {
    id: "token",
    area: "Token",
    name: "LOCO planning worksheet",
    status: "simulation",
    notes: "Local hypothetical allocation worksheet; not an official distribution or commitment.",
  },
];

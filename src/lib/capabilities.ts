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
  { id: "pool-list", area: "Terminal", name: "Pool list, search, sort, pagination", status: "live", notes: "Meteora data API, mainnet only." },
  { id: "practice", area: "Terminal", name: "Practice mode", status: "simulation", notes: "Seeded fictional pools; explicit opt-in; not transactable." },
  { id: "wallet", area: "Wallet", name: "Phantom / Solflare via wallet adapter", status: "live", notes: "No key custody, no emulation." },
  { id: "rail-map", area: "Pool", name: "Rail Map of real bins", status: "live", notes: "SDK getBinsAroundActiveBin via user RPC." },
  { id: "add-liq", area: "Pool", name: "Add liquidity by strategy", status: "live", notes: "initializePositionAndAddLiquidityByStrategy, ephemeral position keypair in memory only; ≤69 bins." },
  { id: "swap", area: "Pool", name: "Direct pool swap", status: "live", notes: "swapQuote + swap; quote bound to amount/direction/slippage/cluster/RPC/wallet, 20s expiry; confirmation-gated success." },
  { id: "tx-runner", area: "Wallet", name: "Transaction runner", status: "live", notes: "Requires wallet signTransaction (no sendTransaction fallback); genesis-hash cluster check before signing; identity re-checked after approval; exact-message simulation; signed-bytes check; every status/height call time-bounded; persisted unresolved signatures with Check status; no automatic resend." },
  { id: "orders", area: "Pool", name: "Native limit orders", status: "live", notes: "SDK isSupportLimitOrder gate; quoteCreateLimitOrder, placeLimitOrder (ephemeral order signer), mainnet discovery via Meteora indexed open orders (paged, capped 5×50) with on-chain program/discriminator/pool/owner verification and SDK getLimitOrder; devnet/custom RPC use the SDK scan. cancelLimitOrder + closeLimitOrderIfEmpty. Built and simulated; not yet signed with a funded wallet." },
  { id: "portfolio", area: "Portfolio", name: "Positions, fees, rewards", status: "live", notes: "Mainnet: Meteora indexed portfolio, every position verified on chain (program, PositionV2 discriminator, pool, owner; ≤100-account reads), drops/truncation shown; watch-only read mode. Devnet: SDK scan." },
  { id: "dispatch", area: "Dispatch", name: "SOL/USDC two-pool DLMM round-trip agent", status: "live", notes: "Mainnet only. Exact-mint discovery (top ≤5 TVL pools), on-chain pool/mint/token-program checks, SDK swapQuote both legs (leg B input = leg A minimum), exact BN cost floor; unknown costs block. One atomic legacy tx (strict create for a temporary WSOL ATA, idempotent USDC create, single wrap, no mid-route unwrap, temp WSOL closed only if created here) via the shared runner with a semantic guard (generation, config, practice, 20 s quote age) before and after wallet approval and an exact getFeeForMessage cap; monitoring pauses during review; unresolved signatures block new runs. Read-only scan + in-tab monitoring verified on live mainnet; composed tx simulated OK with a third-party fee payer (sigVerify off, never signed). Not yet signed with a funded wallet. DLMM Pro not integrated." },
  { id: "agents", area: "Agents", name: "Liquidity Agents · rules, proposals, reviews", status: "live", notes: "Verified fresh positions and arming baselines, per-position volatility, visible in-tab monitoring, risk-first cooldown and strict local rules. Edits cancel work and stale proposals. Frozen reviews get 20s AFTER preparation and simulation, with guards before+after wallet approval. Unknown balances/costs, failed simulation and unresolved signatures block. Native explicit SDK strategies preserve exact odd/even widths and zero net token top-up; SOL fees/rent still apply. Gross redeposit is separate; existing WSOL is preserved. Live mainnet Spot, Curve and BidAsk passed with 46 bins, including decoded range/owner/pool post-state. Two 69-bin Curve attempts hit protocol amount-slippage refusal and stayed unsigned. Real 25% withdrawal simulation also passed. SDK instruction composition is bounded at 45s; individual RPC headers+body at 15s, with no automatic 429 retry. Multi-tx Agent withdrawals blocked before signing; staged moves verify mints and disclose width caps. Funded devnet acceptance passed six 20/21-bin Spot/Curve/BidAsk native moves, exact 25% share withdrawals, WSOL preservation and cleanup: 27 confirmed receipts, zero pending. No funded mainnet signing or browser-wallet rehearsal. Practice/watch-only cannot transact. Ordinary DLMM, no DLMM Pro or background keeper. See docs/OBSERVATORY_RELEASE.md." },
  { id: "claim", area: "Portfolio", name: "Claim fees / rewards", status: "live", notes: "claimSwapFee, claimAllRewardsByPosition." },
  { id: "withdraw", area: "Portfolio", name: "Withdraw % / remove & close", status: "live", notes: "removeLiquidity (bps, shouldClaimAndClose), closePosition." },
  { id: "studio", area: "Studio", name: "Strategy composer previews", status: "simulation", notes: "Shape preview is illustrative; execution uses SDK semantics." },
  { id: "studio-exec", area: "Studio", name: "Execute selected route", status: "live", notes: "v2 plans carry cluster + exact decimal X/Y amounts into the pool review; wrong-cluster plans are blocked; illustrative budget is never converted." },
  { id: "signals", area: "Signals", name: "In-tab range watch", status: "live", notes: "Polls positions while open. No keeper." },
  { id: "rebalance", area: "Signals", name: "Two-step rebalance plan", status: "live", notes: "Non-atomic: withdraw then add, each user-approved. removeLiquidity here enforces no minimum withdrawn amount; shown values are estimates." },
  { id: "fee-weather", area: "Signals", name: "Fee Weather", status: "live", notes: "Actual dynamic/base fees and activity from API. No predictions." },
  { id: "launch", area: "Launch", name: "createLbPair2 wizard", status: "live", notes: "PresetParameter2 fetched onchain, duplicate check, simulation." },
  { id: "dbc", area: "Launch", name: "DBC / DAMM v2 / Alpha Vault", status: "handoff", notes: "Documented only." },
  { id: "lab", area: "Lab", name: "Ballot / sealed bid / histogram", status: "simulation", notes: "Web Crypto AES-GCM + SHA-256 commitments, single local key." },
  { id: "confidential", area: "Lab", name: "Threshold FHE / committee / ZK", status: "not-deployed", notes: "Requires MPC/FHE network, verifier program, DA, audits." },
  { id: "ohlcv", area: "Pool", name: "Price history", status: "live", notes: "Meteora mainnet OHLCV candles 5m–24h; no synthetic data." },
  { id: "network", area: "Network", name: "Cluster & DLMM observatory", status: "live", notes: "RPC slot, block height, version, program account." },
  { id: "ciphernodes", area: "Network", name: "Ciphernode operator network", status: "not-deployed", notes: "Separate future protocol." },
  { id: "governance", area: "Governance", name: "Decision room", status: "simulation", notes: "Local proposals only. No DAO." },
  { id: "token", area: "Token", name: "LOCO planning worksheet", status: "simulation", notes: "Local hypothetical allocation worksheet; not an official distribution or commitment." },
];

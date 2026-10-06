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
  { id: "swap", area: "Pool", name: "Direct pool swap", status: "live", notes: "swapQuote + swap; 20s quote expiry; confirmation-gated success." },
  { id: "orders", area: "Pool", name: "Native limit orders", status: "handoff", notes: "Function mode detected onchain; order placement adapter not implemented." },
  { id: "portfolio", area: "Portfolio", name: "Positions, fees, rewards", status: "live", notes: "getAllLbPairPositionsByUser; requires RPC with getProgramAccounts." },
  { id: "claim", area: "Portfolio", name: "Claim fees / rewards", status: "live", notes: "claimSwapFee, claimAllRewardsByPosition." },
  { id: "withdraw", area: "Portfolio", name: "Withdraw % / remove & close", status: "live", notes: "removeLiquidity (bps, shouldClaimAndClose), closePosition." },
  { id: "studio", area: "Studio", name: "Strategy composer previews", status: "simulation", notes: "Shape preview is illustrative; execution uses SDK semantics." },
  { id: "studio-exec", area: "Studio", name: "Execute selected route", status: "live", notes: "Hands off to pool Add Liquidity flow with prefilled params." },
  { id: "signals", area: "Signals", name: "In-tab range watch", status: "live", notes: "Polls positions while open. No keeper." },
  { id: "rebalance", area: "Signals", name: "Two-step rebalance plan", status: "live", notes: "Non-atomic: withdraw then add, each user-approved." },
  { id: "fee-weather", area: "Signals", name: "Fee Weather", status: "live", notes: "Actual dynamic/base fees and activity from API. No predictions." },
  { id: "launch", area: "Launch", name: "createLbPair2 wizard", status: "live", notes: "PresetParameter2 fetched onchain, duplicate check, simulation." },
  { id: "dbc", area: "Launch", name: "DBC / DAMM v2 / Alpha Vault", status: "handoff", notes: "Documented only." },
  { id: "lab", area: "Lab", name: "Ballot / sealed bid / histogram", status: "simulation", notes: "Web Crypto AES-GCM + SHA-256 commitments, single local key." },
  { id: "confidential", area: "Lab", name: "Threshold FHE / committee / ZK", status: "not-deployed", notes: "Requires MPC/FHE network, verifier program, DA, audits." },
  { id: "network", area: "Network", name: "Cluster & DLMM observatory", status: "live", notes: "RPC slot, block height, version, program account." },
  { id: "ciphernodes", area: "Network", name: "Ciphernode operator network", status: "not-deployed", notes: "Separate future protocol." },
  { id: "governance", area: "Governance", name: "Decision room", status: "simulation", notes: "Local proposals only. No DAO." },
  { id: "token", area: "Token", name: "LOCO token", status: "not-deployed", notes: "No mint, no sale, no tokenomics." },
];

export interface DocArticle {
  id: string;
  title: string;
  group: string;
  body: string[];
  links?: { label: string; url: string }[];
}

export const DOCS: DocArticle[] = [
  {
    id: "wallet",
    group: "Getting started",
    title: "Connecting a wallet",
    body: [
      "Studio Loco uses the standard Solana wallet adapter. Phantom and other Wallet Standard wallets are detected automatically; Solflare is registered explicitly. Click Connect wallet in the terminal header and approve the connection in your wallet.",
      "We never ask for a seed phrase or private key and never store keys. Every transaction is simulated against your RPC first, then sent to your wallet for approval. Nothing is signed automatically.",
      "Settings let you switch between mainnet and devnet and set a custom HTTPS RPC endpoint. The public mainnet RPC is rate-limited and may refuse large account scans (used for portfolios); a dedicated RPC provider is recommended.",
    ],
  },
  {
    id: "bins",
    group: "DLMM",
    title: "Bins, bin step and the active bin",
    body: [
      "DLMM divides price into discrete bins. The bin step (in basis points) is the price distance between neighbouring bins. Trades within a bin execute at a fixed price; when a bin is exhausted the active bin moves.",
      "Bins above the active bin hold token X, bins below hold token Y. The active bin can hold both. Your position only earns swap fees while the active bin lies inside your range.",
    ],
    links: [{ label: "What is DLMM", url: "https://docs.meteora.ag/core-products/dlmm/what-is-dlmm" }],
  },
  {
    id: "fees",
    group: "DLMM",
    title: "Base fees and dynamic fees",
    body: [
      "Each pool has a base fee derived from its bin step and base factor, plus a dynamic (variable) fee that rises with volatility as price crosses bins. The terminal shows both as reported by the Meteora API.",
      "DLMM fee income is swap-fee revenue for liquidity providers. It is not lending yield and is not guaranteed. Fee/TVL is a backward-looking ratio, not a forecast.",
    ],
  },
  {
    id: "strategies",
    group: "DLMM",
    title: "Spot, Curve and BidAsk strategies",
    body: [
      "Spot distributes evenly, Curve concentrates near the active bin, BidAsk weights toward the edges. Studio Loco passes your selected strategy and integer bin range to the official SDK's initializePositionAndAddLiquidityByStrategy, which computes exact per-bin amounts.",
      "New positions in this interface are capped at 69 bins, the tested default position width. The DLMM program supports wider, resizable positions; that flow is not enabled here yet.",
      "One-sided liquidity (only X above price, or only Y below) is not a native limit order. Pools in Limit Order function mode support a distinct native order instruction; the Orders tab checks the onchain mode before showing anything.",
    ],
    links: [{ label: "Strategies & use cases", url: "https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases" }],
  },
  {
    id: "swaps",
    group: "Trading",
    title: "Direct pool swaps",
    body: [
      "The Swap tab trades directly against one DLMM pool, not through an aggregator. A quote is computed by the SDK from fresh bin arrays and shows the expected output, minimum received at your slippage setting, fee and price impact.",
      "Quotes expire after 20 seconds and must be refreshed before signing. Success is shown only after the transaction is confirmed against its blockhash and last valid block height, with an explorer link.",
    ],
  },
  {
    id: "risk",
    group: "Risk",
    title: "Range risk and impermanent loss",
    body: [
      "Concentrated liquidity amplifies both fee income and inventory risk. If price moves through your range, your position converts entirely into the token that lost value relative to the other, and stops earning fees once out of range.",
      "Smart-contract risk, token risk (freeze authorities, transfer fees, blacklisted tokens) and RPC/wallet risk also apply. Blacklisted pools are flagged in the terminal. Never deposit more than you can afford to lose.",
    ],
  },
  {
    id: "signals",
    group: "Tools",
    title: "Signal Box and rebalancing",
    body: [
      "Signal Box watches your real positions while this tab is open and compares each range with the pool's actual active bin. You set a local alert buffer in bins for each position.",
      "There is no keeper or background service: nothing happens when the tab is closed, and nothing is executed without your approval. A rebalance is shown as two separate, non-atomic steps — withdraw/close, then add — each requiring its own wallet approval.",
    ],
  },
  {
    id: "agents",
    group: "Tools",
    title: "Liquidity Agents (The Observatory)",
    body: [
      "Liquidity Agents evaluate rules you arm on your verified DLMM positions: a % price move from an explicit baseline, leaving the range, approaching an edge buffer, observed time out of range, and observed volatility from real mainnet candles. Missing or stale price history is reported as unknown, never as low risk.",
      "The agent only proposes. Monitoring is read-only, runs only while the tab is open and visible, and pauses during review. Each review freezes the rule revision, wallet, network, RPC, position, target, slippage and costs. Its 20-second approval window starts when preparation and simulation finish, and is re-checked before and after wallet approval. Native rebalances preserve the exact original bin count, including even widths, using the SDK's explicit strategy parameters. They use withdrawn position assets rather than requiring a token top-up; SOL is still needed for network fees and any upfront account rent. When a native move cannot be built or does not fit one transaction, a staged withdraw-then-add is offered instead. Watch-only and practice modes can never transact.",
      "Arming fetches a fresh on-chain baseline. Pausing, hiding the tab or editing rules resets observed out-of-range time. A risk exit keeps precedence during its cooldown; stale proposals are removed. Volatility uses each position's own candle window, and missing, duplicate, gapped or future candles are unavailable rather than low risk.",
      "Agents preserve existing wrapped SOL accounts and return SOL as WSOL. Approval requires a known wallet balance, known exact-message fees and a successful simulation. The SOL requirement includes upfront account rent without counting the network fee twice or treating withdrawn WSOL as rent. Unresolved signatures block new actions even after reloading. Withdrawals that require multiple transactions are blocked in Agents before any signature; review those through the position withdrawal flow. Staged moves verify destination mints on chain and disclose any narrower add range before withdrawal.",
      "Release validation distinguishes an unsigned simulation from a confirmed, funded transaction. Native rebalance passed read-only mainnet simulation with decoded position post-state checks. Funded devnet acceptance passed Spot, Curve and BidAsk at both 20 and 21 bins: six native moves, six exact 25% share withdrawals, WSOL preservation and six position cleanups, with 27 confirmed transactions including setup. Funded mainnet signing and a browser-wallet rehearsal have not been performed. A protocol slippage refusal or unknown balance disables approval. The Observatory uses ordinary Meteora DLMM, not DLMM Pro, and has no background keeper.",
    ],
  },
  {
    id: "launch",
    group: "Tools",
    title: "Launching a DLMM pool",
    body: [
      "Launch Station builds the official createLbPair2 transaction from a PresetParameter2 account fetched onchain. Mints are validated onchain to read decimals and token program. The initial price is entered in quote (Y) per base (X) and converted to an active bin using both tokens' decimals.",
      "A duplicate check derives the pool address for the preset and mint pair and refuses to proceed if it exists. Pool creation does not add liquidity; seed it afterwards from the pool page.",
      "Dynamic Bonding Curve (DBC), DAMM v2 and Alpha Vault are separate Meteora products. DBC graduates to DAMM, not DLMM. Studio Loco documents configuration handoffs for them but does not implement their adapters.",
    ],
  },
  {
    id: "privacy",
    group: "Privacy",
    title: "The privacy distinction",
    body: [
      "Meteora DLMM is fully public: positions, swaps and fees are visible onchain. It provides no private ballots, sealed bids or encrypted order flow.",
      "The Coordination Lab is a local educational simulation of a confidential-coordination lifecycle using Web Crypto. It has no committee, threshold decryption, FHE or zero-knowledge proofs, and is not a deployed protocol.",
    ],
  },
  {
    id: "dev",
    group: "Development",
    title: "Development and integration sources",
    body: [
      "Studio Loco is built with TanStack Start, the official @meteora-ag/dlmm SDK (pinned), @solana/web3.js and the Solana wallet adapter. Pool lists come from the public Meteora data API (dlmm.datapi.meteora.ag). The SDK is loaded lazily on pages that need chain access.",
      "The repository contains docs/RESEARCH.md with capability mapping and src/lib/capabilities.ts, a registry of implemented, simulated and deployment-dependent features.",
    ],
    links: [
      { label: "SDK getting started", url: "https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/getting-started" },
      { label: "SDK reference", url: "https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference" },
      { label: "Pools API", url: "https://docs.meteora.ag/api-reference/dlmm/pools/pools" },
      { label: "dlmm-sdk on GitHub", url: "https://github.com/MeteoraAg/dlmm-sdk" },
    ],
  },
];

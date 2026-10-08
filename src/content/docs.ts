export interface DocArticle {
  id: string;
  title: string;
  group: string;
  body: string[];
  links?: { label: string; url: string }[];
}

export const DOCS: DocArticle[] = [
  { id: "developer-sdk", group: "Developers", title: "Build with the Loco SDK, API and MCP", body: [
    "Developer Station at /developers includes a versioned downloadable npm package, TypeScript examples, OpenAPI specification, actual API explorer and both hosted and stdio MCP configuration. The package is distributed by Loco, not published to the npm registry.",
    "API v1 distinguishes Meteora-index metadata from confirmed Solana snapshots. Every response carries source, mainnet cluster, version and observed time. Positions verify mainnet genesis, DLMM program, PositionV2 and LbPair discriminators, pool binding, mint programs and initialized decimals. Pool and position bounds share one confirmed slot; mints are read at or above it. Unavailable metrics remain null; invalid rows are counted and request caps are explicit.",
    "The SDK's range helper is exact-width geometry only, not the app's native Rebalance Planner or a cost/profit forecast. Recorder export analysis uses the same strict schema as the app and returns aggregate evidence-consistency counts locally. Exports remain user-supplied claims; their confirmations are not independently checked on chain.",
    "Hosted MCP registers five read-only tools with actual read-only handlers. No wallet signing, transaction submission, generic RPC, devnet, custom RPC URLs, private cloud history or DLMM Pro is exposed. An optional sixth Recorder analysis tool is local stdio only, explicitly enabled with --local-evidence. The hosted connection cannot receive or browse private Recorder exports.",
  ], links: [{label: "Developer Station", url: "/developers"}, {label: "SDK source and examples", url: "https://github.com/jjyaz/studio-loco/tree/main/packages/sdk"}] },

  {
    id: "wallet",
    group: "Getting started",
    title: "Connecting a wallet",
    body: [
      "Studio Loco uses the standard Solana wallet adapter. Phantom and other Wallet Standard wallets are detected automatically; Solflare is registered explicitly. Click Connect wallet in the terminal header and approve the connection in your wallet.",
      "We never ask for a seed phrase or private key and never store keys. Every transaction is simulated against your RPC first, then sent to your wallet for approval. Nothing is signed automatically.",
      "Settings let you switch between mainnet and devnet and set a custom HTTPS RPC endpoint. The public mainnet RPC is rate-limited and may refuse large account scans (used for portfolios); a dedicated RPC provider is recommended.",
      "Wallet Checks verifies the RPC's genesis hash and offers a devnet-only memo rehearsal. It transfers no tokens and creates no accounts, but its reviewed network fee is real devnet SOL. A frozen review lasts 20 seconds after exact simulation. Approve or decline in your own wallet; only a confirmed receipt means it passed. Network, wallet or page changes discard unsent approvals. A shared transaction slot prevents concurrent wallet actions, and unresolved signatures survive reload for Check status without automatic resend.",
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
    title: "Signals and two-step rebalancing",
    body: [
      "The Signals page watches positions while the tab is open and compares each range with the pool's actual active bin. You set a local alert buffer in bins for each position. Signal Box is the separate hosted watch service for observations while the tab is closed.",
      "The Signals page offers a two-step rebalance plan: withdraw/close, then add, each requiring wallet approval. The Observatory can also prepare a native rebalance when supported. Every action uses a fresh review, simulation and your own wallet approval.",
    ],
  },
  {
    id: "agents",
    group: "Tools",
    title: "Liquidity Agents (The Observatory)",
    body: [
      "Liquidity Agents evaluate rules you arm on your verified DLMM positions: a % price move from an explicit baseline, leaving the range, approaching an edge buffer, observed time out of range, and observed volatility from real mainnet candles. Missing or stale price history is reported as unknown, never as low risk.",
      "The Rebalance Planner compares staying put, recentering at the current width, widening to an explicit range (up to 69 bins), and a verified same-mint pool move. Native options build unsigned transactions and show exact first-step simulations, token amounts, SDK rent quotes and fee/SOL requirements. Later staged costs stay unpriced. A pool move leaves fees and rewards in the original open position, withdraws liquidity first and opens a separately approved destination deposit from actual balances. Comparisons, detailed options, selections, fresh reviews and wallet receipts are linked in Flight Recorder. No plan or imported evidence can execute itself. Comparisons expire after two minutes; wallet reviews expire after twenty seconds. Recovery estimates use only your recorded fee-income assumption and complete simulated SOL outflow, never a forecast.",
      "The agent only proposes. Monitoring is read-only, runs only while the tab is open and visible, and pauses during review. Each review freezes the rule revision, wallet, network, RPC, position, target, slippage and costs. Its 20-second approval window starts when preparation and simulation finish, and is re-checked before and after wallet approval. Native rebalances preserve the exact original bin count, including even widths, using the SDK's explicit strategy parameters. They use withdrawn position assets rather than requiring a token top-up; SOL is still needed for network fees and any upfront account rent. When a native move cannot be built or does not fit one transaction, a staged withdraw-then-add is offered instead. Watch-only and practice modes can never transact.",
      "Arming fetches a fresh on-chain baseline. Pausing, hiding the tab or editing rules resets observed out-of-range time. A risk exit keeps precedence during its cooldown; stale proposals are removed. Volatility uses each position's own candle window, and missing, duplicate, gapped or future candles are unavailable rather than low risk.",
      "Agents preserve existing wrapped SOL accounts and return SOL as WSOL. Approval requires a known wallet balance, known exact-message fees and a successful simulation. The SOL requirement includes upfront account rent without counting the network fee twice or treating withdrawn WSOL as rent. Unresolved signatures block new actions even after reloading. Withdrawals that require multiple transactions are blocked in Agents before any signature; review those through the position withdrawal flow. Staged moves verify destination mints on chain and disclose any narrower add range before withdrawal.",
      "Release validation distinguishes an unsigned simulation from a confirmed, funded transaction. Native rebalance passed read-only mainnet simulation with decoded position post-state checks. Funded devnet acceptance passed Spot, Curve and BidAsk at both 20 and 21 bins: six native moves, six exact 25% share withdrawals, WSOL preservation and six position cleanups, with 27 confirmed transactions including setup. Funded mainnet signing and a browser-wallet rehearsal have not been performed. A protocol slippage refusal or unknown balance disables approval. The Observatory uses ordinary Meteora DLMM. Signal Box can observe hosted rules in the background and hand off to a fresh Observatory review; it cannot execute them.",
    ],
  },
  {
    id: "signal-box",
    group: "Tools",
    title: "Signal Box: hosted watches and alerts",
    body: [
      "Sign in to a private workspace, then add a mainnet position watch or one SOL/USDC arbitrage watch. Position creation verifies the pool, position, owner and token identities and captures a fresh arming baseline. Up to five watches are allowed per account, including at most one arbitrage watch. Watches expire after seven days and can be paused, renewed, edited or deleted.",
      "A server scheduler runs every five minutes, independently of browser tabs. Position watches use the Observatory's deterministic rules, risk precedence and cooldowns. Arbitrage scans run at most once per fifteen-minute cadence and use estimated fees and rent, with no wallet funds or signing access. Each successful observation records a confirmed chain context; failed reads are unavailable. Observation gaps restart continuous out-of-range time.",
      "Alerts are retained in a private inbox. Optional browser notifications require an explicit permission click and a device linked to the current account. A provider accepting a push request does not prove delivery; send a test and check that a notification appears. Email alerts are unavailable. The Scheduler health tab reports recent completed checks; quiet lamps alone do not prove a healthy watch.",
      "Opening an alert carries identifiers only. Load watch rules in the Observatory or Dispatch to verify workspace ownership, current revision and expiry. Then run a fresh chain check or scan and prepare a new wallet-specific review. Edited, paused, expired or deleted watches cannot hand off stale rules. A previous arbitrage opportunity may have passed, and its old payload never becomes a transaction to sign.",
    ],
  },
  {
    id: "recorder",
    group: "Tools",
    title: "The Flight Recorder",
    body: [
      "The Recorder stores structured proposals, reviews, alert handoffs and shared-runner wallet actions in this browser. Each action has a timeline, reviewed context, per-step phases and public signatures. Reconciliation checks an unresolved signature without sending it again. A confirmation is distinct from a separate transaction metadata read; unavailable receipts do not show verified balance changes.",
      "Wallet balance deltas use confirmed transaction metadata and exact raw token units. Unsafe numeric lamport values are omitted. They include fee and rent effects and are not a profit calculation or a separate position-state verification. Imported files carry their own identities and an import label; their confirmation claims have not been independently verified by this device.",
      "Records contain no RPC URLs, credentials or signed transaction bytes. Export JSON for a portable copy, or sign in and explicitly sync a private cloud copy protected by account ownership. Newer cloud evidence wins over a stale device copy. Wallet actions and unresolved records are not automatically evicted; the latest two thousand other facts are retained. If browser storage fails, session-only records remain visible and can be exported before closing the tab.",
    ],
  },
  {
    id: "replay",
    group: "Tools",
    title: "The Replay Room",
    body: [
      "Replay loads completed mainnet Meteora OHLCV candles: 24 hours at 5-minute resolution or seven days at hourly resolution. It requires pool bin step and both token decimals, refuses malformed or duplicate candles, and reports missing periods. Practice is a separately selected, deterministic fixture and never an API-error fallback. No wallet connection or signing is needed.",
      "History is fetched in sequential windows of at most 96 completed periods because the Data API rejects larger single requests. Inclusive boundary rows are excluded before stitching; missing windows remain gaps. A failed request stops the entire load, and a 40-second overall deadline prevents an indefinite wait. The exported tape records the request windows as well as the final candles.",
      "The same Observatory rules evaluate each completed close using only the history available then. Risk exits retain priority during cooldown. Out-of-range observation time restarts after gaps and volatility requires consecutive closes in the rule's requested frame. Bin IDs are inferred from candle prices and pool metadata; they are not historical on-chain active-bin records.",
      "Coverage means close samples inside a modeled bin range, not continuous time in range. Intrabar high/low excursions are flagged without inventing their order. The first close initializes the range and is excluded from intrabar coverage. Template comparisons vary width and distribution; distribution alone does not change geometric coverage at the same width.",
      "Optional modeled rebalances assume an approval at one close and apply that frozen target before the next observation. The model does not reconstruct execution delay, slippage, token balances, fees, rewards, impermanent loss or profit. Risk withdrawals remain proposals. Playback, a keyboard-accessible observation slider and JSON export let you inspect and reproduce the exact tape, rules, decisions and assumptions.",
    ],
    links: [{ label: "Meteora DLMM Data API", url: "https://github.com/MeteoraAg/docs/blob/main/developer-guides/dlmm/api-reference/overview.mdx" }],
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

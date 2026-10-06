export interface Note {
  slug: string;
  title: string;
  date: string; // ISO
  code: string;
  summary: string;
  sections: { heading: string; body: string[] }[];
  sources: { label: string; url: string }[];
}

export const NOTES: Note[] = [
  {
    slug: "stations-not-curves",
    title: "Stations, not curves: how DLMM bins price a market",
    date: "2026-09-14",
    code: "FN-001",
    summary: "Meteora DLMM replaces a continuous curve with discrete price bins. Here is what that means when you place liquidity.",
    sections: [
      {
        heading: "A line of stations",
        body: [
          "A classic constant-product pool spreads liquidity across every possible price. DLMM instead cuts the price axis into discrete bins. Each bin is a single price, and inside a bin trades execute at that price with zero slippage until the bin's reserves are used up.",
          "Neighbouring bins are separated by the pool's bin step, measured in basis points. A 25 bps bin step means each station is 0.25% further along the line than the last. The price of bin i is (1 + binStep/10,000)^i, adjusted for token decimals.",
        ],
      },
      {
        heading: "Where the train stands",
        body: [
          "Exactly one bin is active at any time. Bins above the active bin hold only token X; bins below hold only token Y; the active bin can hold both. When a trade drains the active bin, the price moves to the next station and that bin becomes active.",
          "This is why a one-sided deposit above the current price is entirely X, and why a range that drifts out of the active bin stops earning swap fees until price returns.",
        ],
      },
      {
        heading: "What Studio Loco shows you",
        body: [
          "The Rail Map on every pool page draws real bins fetched with the official SDK around the active bin, with the active station marked. Range selection always resolves to whole bin ids, and transactions are built by the SDK from those integer bins.",
        ],
      },
    ],
    sources: [
      { label: "Meteora — What is DLMM", url: "https://docs.meteora.ag/core-products/dlmm/what-is-dlmm" },
      { label: "Meteora DLMM SDK (GitHub)", url: "https://github.com/MeteoraAg/dlmm-sdk" },
    ],
  },
  {
    slug: "local-express-switchback",
    title: "Local, Express, Switchback: reading Spot, Curve and BidAsk",
    date: "2026-09-22",
    code: "FN-002",
    summary: "Three strategy shapes, three different bets on how price will move. None of them is a guaranteed return.",
    sections: [
      {
        heading: "Spot — the Local",
        body: [
          "Spot spreads liquidity evenly across your range. It is the most forgiving shape when you are unsure where price will travel, at the cost of lower concentration around the active bin.",
        ],
      },
      {
        heading: "Curve — the Express",
        body: [
          "Curve concentrates liquidity near the centre of the range. When price stays close to the active bin, a larger share of volume passes through your liquidity. When price moves away, the thin edges earn little and the position can fall out of range quickly.",
        ],
      },
      {
        heading: "BidAsk — the Switchback",
        body: [
          "BidAsk places more liquidity toward the edges. It is often used to capture volatility or to accumulate one side as price swings. It is not the same as a native limit order: liquidity still behaves as LP inventory and can be swapped back as price returns.",
        ],
      },
      {
        heading: "What the Studio does and does not claim",
        body: [
          "Strategy Studio previews are illustrative simulations of shape, labelled as such. Exact per-bin amounts are computed by the official SDK when a transaction is prepared. We do not rank strategies by expected return, because no honest tool can.",
        ],
      },
    ],
    sources: [
      { label: "Meteora — Strategies & use cases", url: "https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases" },
      { label: "DLMM TypeScript SDK examples", url: "https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/examples" },
    ],
  },
  {
    slug: "what-encryption-is-not",
    title: "What browser encryption is not: notes on private coordination",
    date: "2026-10-01",
    code: "FN-003",
    summary: "Confidential coordination protocols combine committees, threshold keys and proofs. A browser demo does not. Here is the difference.",
    sections: [
      {
        heading: "The protocol pattern",
        body: [
          "Confidential coordination systems such as The Interfold (formerly Enclave) on Ethereum describe a lifecycle: a computation is requested, a random committee is selected, the committee runs distributed key generation, participants submit encrypted inputs, the computation runs over ciphertexts with proofs of correctness, and only the aggregate is threshold-decrypted.",
          "The guarantees come from the combination: no single party holds the decryption key, inputs are authenticated, data is available for verification, and misbehaving operators can be penalised.",
        ],
      },
      {
        heading: "What our Lab does",
        body: [
          "The Coordination Lab runs the same lifecycle shape in your browser. Contributions are encrypted with AES-GCM via Web Crypto and committed with SHA-256. After the window closes the local tally decrypts, aggregates and re-checks every commitment.",
          "Because one browser holds the key, this provides none of the committee, threshold or verifiable-computation guarantees. It is labelled a local educational simulation everywhere it appears.",
        ],
      },
      {
        heading: "What Meteora is and is not",
        body: [
          "Meteora DLMM is public liquidity infrastructure on Solana. Swaps, positions and fees are transparent onchain. Using DLMM does not provide sealed bids, private ballots or encrypted order flow, and Studio Loco never claims it does.",
        ],
      },
    ],
    sources: [
      { label: "The Interfold", url: "https://www.theinterfold.com/" },
      { label: "MDN — SubtleCrypto", url: "https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto" },
      { label: "Meteora — What is DLMM", url: "https://docs.meteora.ag/core-products/dlmm/what-is-dlmm" },
    ],
  },
];

export const getNote = (slug: string) => NOTES.find((n) => n.slug === slug);

# Roadmap

- [x] Remove “no LOCO token” statements across site copy and metadata, preserving simulation labels and avoiding unverified claims.

- [x] Check existing project secret names (names only) — no Helius/RPC secret exists
- [x] Verify PublicNode mainnet (genesis hash, getSlot, DLMM reads) — all passed; wired as default mainnet upstream, SOLANA_MAINNET_RPC_URL override kept higher priority
- [x] Devnet unchanged (public Solana endpoint; custom RPC fallback); relay allowlist/limits/no-secret-logs preserved
- [x] Docs updated (RESEARCH.md, RELEASE_CHECKLIST.md, AGENTS.md)
- [x] Typecheck, 64/64 tests, build all exit 0 — SHA 1b0ba323b6e804c68af37fd2778c97966d6663d0
- [ ] User: publish, then verify deployed relay + pool bins/quotes

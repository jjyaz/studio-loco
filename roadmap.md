# Roadmap

- [x] Remove “no LOCO token” statements across site copy and metadata, preserving simulation labels and avoiding unverified claims.

- [x] Check existing project secret names (names only) — no Helius/RPC secret exists
- [x] Verify PublicNode mainnet (genesis hash, getSlot, DLMM reads) — all passed; wired as default mainnet upstream, SOLANA_MAINNET_RPC_URL override kept higher priority
- [x] Devnet unchanged (public Solana endpoint; custom RPC fallback); relay allowlist/limits/no-secret-logs preserved
- [x] Docs updated (RESEARCH.md, RELEASE_CHECKLIST.md, AGENTS.md)
- [x] Typecheck, 64/64 tests, build all exit 0 — SHA 1b0ba323b6e804c68af37fd2778c97966d6663d0
- [ ] User: publish, then verify deployed relay + pool bins/quotes

### Journey Continuity
Implemented local strategy lifecycle, prepared-intent/confirmed-receipt verification, named native account-role binding, non-atomic move recovery, strict supplied-evidence transfer and SDK/local MCP analysis. Funded origin/rebalance/move acceptance remains a user-wallet gate; no assistant signing, no Pro execution, no PnL or private-history public endpoint.

### Conductor v2 (operation ledger / budgets / hosted observation)
- [x] Pure SDK ledger contracts: states, cumulative budgets across revisions, fail-closed reservation checks, release rules (packages/sdk/src/ledger.ts + tests)
- [ ] Durable cross-tab IndexedDB ledger store with atomic reserve-before-prompt
- [ ] Instruction/recipient decoding + mission guard in shared runner (pre-sign and post-approval)
- [ ] Conductor/Recorder/Journey UI: matrix, remaining/reserved/consumed, reconcile
- [ ] Hosted mission observation (schema, RLS, worker reusing lease/cron)
- [ ] SDK 0.6 release, local MCP analyzer, docs/capabilities/AGENTS

### The Depot (DBC launch / agent passports / Scout / fee desk)
- [x] Pure deterministic core: presets, exact raw launch math, explicit recipients, review binding/expiry/SOL caps, wallet-control challenge + nonce replay, token gate, AI-brief factuality (src/lib/depot.ts + 19 tests)
- [x] Pinned DBC 1.5.11 + cp-amm 1.4.5 SDK builders through tx.ts
- [x] Cloud schema + server fns: passports, wallet proofs, publication, immutable metadata routes (docs/DEPOT_BACKEND.md)
- [x] Scout report, AI brief with factuality check, holder-gated reads
- [x] recordVerifiedLaunch (exact message reconstruction + DB CAS)
- [x] Lifecycle/migration, fee desk, operation ledger, Recorder links
- [x] Depot UI routes/nav, capabilities, docs/DEPOT_RELEASE.md
- [ ] User: funded mainnet launch → verify/link → graduation/claims acceptance; signed-in workspace browser pass

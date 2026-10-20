# The Depot — backend slice (passports, wallet proof, metadata, Scout)

Status: full app workspace and public passports are wired. The source includes official DBC/DAMM v2 adapters and durable wallet-reviewed operations. Unsigned mainnet launch simulation passed. No funded launch or financial signature was performed during implementation. Publishing the app is separate from wallet acceptance. See `DEPOT_PROTOCOL_QA.md` and `DEPOT_RELEASE.md`.

## Server functions (`src/lib/depot.functions.ts`)
Wallet authenticated (`requireDepotWalletAuth`; explicit server-derived principal filters on owner queries):
- `listMyAgents()` → `{ok, agents: AgentDTO[]}`
- `createAgent({name, description?, mission:"scout"})` (max 10 per account)
- `updateAgent({id, revision, name?, description?, reportPolicy?, gateMint?, gateMinRaw?, gateMaxAgeS?})` — revision CAS; holder policy requires verified wallet + mint + raw min
- `deleteAgent({id, revision})` — reports/nonces cascade; published metadata stays immutable and resolvable
- `requestWalletChallenge({agentId, wallet, purpose:"controller"|"viewer"})` → `{challenge, message}` (5 min, 10 per 10 min, allowlisted host)
- `verifyWalletChallenge({agentId, wallet, purpose, nonce, signature})` — ed25519 over exact UTF-8 message; atomic single-use `depot_consume_nonce`
- `setPassportPublished({id, revision, publish})` — publishing requires verified controller wallet
- `publishTokenMetadata({agentId, name, symbol, description, imageBase64, imageMime, confirmImmutable:true})` → `{digest, uri, version, immutable, cost}`
- `runScoutReport({agentId, pool, probesX[], probesY[], withAi})` — real mainnet read via the Conductor adapter; 20/h, AI 5/h
- `listMyReports({agentId})`, `listGatedReports({agentId, wallet})` — fresh server SPL balance of the caller's connected, recently proven viewer wallet; atomic revision/policy check at protected content delivery
- `listMyTokenMetadata({agentId})` — immutable metadata versions for the owned agent
- `recordVerifiedLaunch({agentId, revision, config, mint, pool, signature, metadataDigest, presetId, presetVersion})` — reconstruct original launch message byte-for-byte against the confirmed receipt, independently verify current protocol identities, then CAS-link the launch
Public: `getPublicPassport({id})`, `listPublicReports({agentId})` (only public agents with public policy).

Public routes: `GET /api/public/depot/metadata/:sha256`, `GET /api/public/depot/image/:sha256` — digest re-verified, immutable cache, no external fetch.

## Database (migrations 0003–0007)
`depot_agents`, `depot_nonces`, `depot_viewer_wallets`, `depot_images`, `depot_metadata`, `depot_reports`. Depot owner reads and writes go through authenticated server handlers with explicit principal filters; anonymous table access stays revoked. Anon has no table access; public reads only via whitelisted definer functions. Metadata/images are trigger-immutable. Service-only `depot_publish_metadata` atomically verifies hashes, applies account quotas, allocates a version and inserts image + metadata. Canonical public metadata uses studioloco.cfd, including an agent-specific passport URL. Service-only `depot_link_launch` enforces owned metadata, wallet identity, immutable launch identity, unique mint/signature and revision CAS. A launched agent cannot switch its controller wallet. Service-only `depot_holder_reports` rechecks current visibility, revision, gate, proof wallet and age in the same statement that returns contents.

## Verified this slice
- Final suite: 612/612 tests in 66 files, including SDK-built instruction proofs, durable recovery, exact receipt linkage, wallet-change races and protected-content isolation. TypeScript and production build pass.
- DB acceptance (forced rollback): wrong wallet/user/domain/expired/replay refused; single valid consume; private hidden; public whitelisted; anon/auth grants locked.
- Atomic DB acceptance (forced rollback): immutable/idempotent publication, cross-agent reuse and wrong-owner refusal, no retained image after invalid publication, holder proof/balance freshness, current policy/revision, launch CAS/idempotency/immutability, controller binding and service-only grants. Every assertion passed; all fixtures rolled back.
- Live read-only mainnet Scout on SOL-USDC `5rCf1DM8…AS6`: real slot, quotes, gaps. Live AI brief returned and passed factuality checks.
- Not tested: real browser-wallet signing of the proof message, holder-gated read with a real holder wallet, metadata publication from the public HTTPS site, any launch.

The Lovable preview required sign-in in the available browser. UI verification used React DOM interaction tests and a production compile; a full authenticated browser walkthrough is still outstanding. No test result should be presented as a funded launch, fee claim or autonomous agent operation.

## Wallet sign-in

The Depot now uses first-party wallet-signature sessions rather than email login. See `DEPOT_WALLET_AUTH.md` for cookie, origin, single-use challenge, owner-scoping and migration boundaries. Authentication tables/RPCs are added by migration 0008. Other private workspaces retain their existing auth.

# The Depot — backend slice (passports, wallet proof, metadata, Scout)

Status: server functions, DB schema and public metadata routes implemented. No UI wired yet. No launch, no signing, no funded test.

## Server functions (`src/lib/depot.functions.ts`)
Authenticated (`requireSupabaseAuth`):
- `listMyAgents()` → `{ok, agents: AgentDTO[]}`
- `createAgent({name, description?, mission:"scout"})` (max 10 per account)
- `updateAgent({id, revision, name?, description?, reportPolicy?, gateMint?, gateMinRaw?, gateMaxAgeS?})` — revision CAS; holder policy requires verified wallet + mint + raw min
- `deleteAgent({id, revision})` — reports/nonces cascade; published metadata stays immutable and resolvable
- `requestWalletChallenge({agentId, wallet, purpose:"controller"|"viewer"})` → `{challenge, message}` (5 min, 10 per 10 min, allowlisted host)
- `verifyWalletChallenge({agentId, wallet, purpose, nonce, signature})` — ed25519 over exact UTF-8 message; atomic single-use `depot_consume_nonce`
- `setPassportPublished({id, revision, publish})` — publishing requires verified controller wallet
- `publishTokenMetadata({agentId, name, symbol, description, imageBase64, imageMime, confirmImmutable:true})` → `{digest, uri, version, immutable, cost}`
- `runScoutReport({agentId, pool, probesX[], probesY[], withAi})` — real mainnet read via the Conductor adapter; 20/h, AI 5/h
- `listMyReports({agentId})`, `listGatedReports({agentId})` — fresh server SPL balance of the caller's proven viewer wallet
Public: `getPublicPassport({id})`, `listPublicReports({agentId})` (only public agents with public policy).

Public routes: `GET /api/public/depot/metadata/:sha256`, `GET /api/public/depot/image/:sha256` — digest re-verified, immutable cache, no external fetch.

## Database (migrations 0003–0005)
`depot_agents`, `depot_nonces`, `depot_viewer_wallets`, `depot_images`, `depot_metadata`, `depot_reports`. Owners read own rows; all writes via server. Anon has no table access; public reads only via whitelisted definer functions. Metadata/images are trigger-immutable. `launch` column is reserved: no write path until server-side chain verification exists (depends on the DBC adapter).

## Verified this slice
- 35 Depot unit tests (signature/replay/domain, sanitization, metadata integrity, gate thresholds, AI factuality). Full suite 583/583 on first run; on a second run one untouched Conductor storage test hit its 5 s timeout and failed again when run alone (not investigated).
- DB acceptance (forced rollback): wrong wallet/user/domain/expired/replay refused; single valid consume; private hidden; public whitelisted; anon/auth grants locked.
- Live read-only mainnet Scout on SOL-USDC `5rCf1DM8…AS6`: real slot, quotes, gaps. Live AI brief returned and passed factuality checks.
- Not tested: real browser-wallet signing of the proof message, holder-gated read with a real holder wallet, metadata publication from the public HTTPS site, any launch.

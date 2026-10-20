# Depot wallet sign-in

The Depot and holder-report sign-in use Solana wallet message signatures. No email address, password, Google login, transaction or SOL payment is required. Other Studio Loco workspace authentication is unchanged.

Lovable Cloud does not expose its disabled native Supabase Web3 provider setting. The Depot therefore uses a first-party authentication boundary rather than a fake email identity or a client-generated Supabase JWT.

## Authentication boundary

1. Connect a wallet. `POST /api/public/depot/auth/challenge` creates a random nonce valid for five minutes, bound to the exact allowed HTTPS host and wallet.
2. The browser independently rebuilds the canonical sign-in text before asking the selected wallet to sign. Wallet changes, including away-and-back races, invalidate the attempt.
3. `POST .../verify` verifies the Ed25519 signature, then atomically consumes the nonce and resolves one stable random UUID principal per wallet. A replay cannot create another session.
4. The server creates a random 256-bit opaque token. Only its SHA-256 hash is stored. The raw token appears only in the Secure, HttpOnly, SameSite=Strict, host-only `__Host-loco-depot-session-<wallet>` cookie, with a twelve-hour lifetime.
5. Every protected Depot function rechecks the session against the actual host and the explicit connected-wallet header. The authenticated principal is derived server-side; callers cannot supply an account UUID. Private queries use explicit principal filters. Existing table RLS/grants are retained; the new auth tables and RPCs are service-only.

The cookie never enters localStorage, IndexedDB, URLs, Recorder facts, RPC evidence or JSON responses. Browser auth notifications contain only a timestamp. Switching/disconnecting wallets hides private content immediately; stale session responses are dropped. Tabs recheck after auth changes and focus. Cookie names are wallet-scoped, so a late sign-in response for one wallet cannot overwrite another wallet's session. A different wallet's logout cannot revoke or clear the active cookie. Actual logout revokes the matching session before clearing the cookie.

Challenge issuance is limited atomically to twenty requests per ten minutes for a wallet/IP bucket and one thousand globally per hour. IP input is hashed; no raw IP is retained in these tables. Expired nonce/session rows are pruned during challenge issuance. At most ten active sessions remain per wallet. Only exact approved origins can mutate authentication state; request bodies are limited to 4 KiB and all responses disable caching.

## Data and transaction scope

`depot.functions.ts` uses `requireDepotWalletAuth`. Owner reads/writes explicitly filter `user_id`; launch linking additionally verifies metadata ownership and reconstructs the exact confirmed message. Public passports/reports keep their existing whitelist and policy checks. A holder's viewer proof must match the signed-in wallet. Agent-specific wallet-control proof remains separate from account login; all financial actions still use the shared simulated wallet runner.

Existing email-account records are not transferred or deleted. Wallet principals have separate UUIDs. Before this change the backend reported no Auth identities, so no existing email user workspace required migration for this release. A future migration must explicitly verify both identities and preserve original ownership evidence.

## Verification

Cryptographic handler tests use real Ed25519 signatures and exercise domain, expiry, replay, cookie, connected-wallet and logout boundaries. UI tests cover canonical messages, wallet changes, refused cookie persistence and immediate workspace isolation. Handler tests exercise owner filtering with a server-only client rather than assuming RLS scopes that client. The deployed SQL acceptance script intentionally rolls back all fixtures after testing nonce consumption, stable principals, session expiry/revocation, quotas and grants.

A production acceptance check must exercise these HTTP endpoints with a temporary unfunded test wallet, without printing or retaining keys/session cookies. That verifies authentication only; it is not a funded token launch or graduation test.

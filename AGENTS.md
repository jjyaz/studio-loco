<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Live data services (`src/lib/meteora-api.ts`, SDK in `src/lib/dlmm.ts`) and practice fixtures (`src/lib/practice-data.ts`) stay separate; never fall back to fixtures on error — honesty requirement.
- Every wallet transaction goes through `src/lib/tx.ts` (simulate → sign → poll confirmation) — success must mean confirmed.
- The DLMM SDK is loaded lazily via `loadSdk()` — keeps public pages light and SSR-safe.
- Default RPC goes through the allowlisted relay `src/routes/api/public/rpc.$cluster.ts` (browser origins are rejected by public RPC); mainnet defaults to PublicNode's verified keyless endpoint, server env SOLANA_MAINNET_RPC_URL/SOLANA_DEVNET_RPC_URL overrides win when set; custom RPCs bypass it.
- Feature truth lives in `src/lib/capabilities.ts`; update it when a feature's status changes.
- `exactOptionalPropertyTypes` is disabled — SDK and router types are incompatible with it.
- Server (Worker) build environments add the "browser" resolve condition via a plugin in vite.config.ts — some Solana deps export only browser/node conditions.
- Resolve each installed Anchor version to its browser entry and bundle Anchor/DLMM in SSR — Anchor's ESM entry references undefined CommonJS exports in the published runtime.
- Client builds resolve `buffer`/`node:buffer` to the npm buffer package via the first plugin in vite.config.ts — otherwise Vite substitutes an empty stub and hydration crashes.

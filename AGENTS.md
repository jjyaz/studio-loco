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
- Client builds resolve `buffer`/`node:buffer` to the npm buffer package via the first plugin in vite.config.ts — otherwise Vite substitutes an empty stub and hydration crashes. The plugin is build-only (`apply: "build"`): in dev it must stay off or Vite serves the raw CJS entry and `import { Buffer } from "buffer"` fails to hydrate.
- Browser globals (Buffer/global/process) are installed by calling `installNodeGlobals()` explicitly, never by side-effect import — `"sideEffects": false` lets the bundler drop bare imports.
- The relay splits default-mainnet `getMultipleAccounts` calls into ≤10-key chunks — PublicNode blocks larger ones.
- Arbitrage math lives in `src/lib/arb-math.ts` (pure, exact BN) and chain composition in `src/lib/arb.ts`; round trips are one atomic tx built from raw `swap2` instructions, never the SDK `swap()` helper, because that helper unwraps/closes the WSOL account between legs.

- Money-moving flows with time- or input-sensitive reviews pass `semanticGuard` (and `maxFeeLamports` when the floor depends on the fee) to the shared runner — identity checks alone cannot catch expired quotes or config changes during wallet approval.

- Dispatch scan/requote work runs through `src/lib/job-control.ts` (single-flight lock, monotonic generation, bounded steps, drain latch) — timed-out RPC promises cannot be aborted, so new jobs must wait for them to settle.

- Liquidity Agents logic is split: pure rules/triggers/review-freshness in `src/lib/agents.ts`, SDK/API composition in `src/lib/agents-chain.ts`, practice fixture in `src/lib/agents-practice.ts` — keeps money-guard logic testable and practice data out of the live builder.

- Signal Box: pure tick rules in `src/lib/signal-box.ts`, worker in `src/lib/signal-worker.server.ts` behind the token-checked hook `src/routes/api/public/hooks/signal-tick.ts`, commits only via the `signal_commit` DB function — revision/status/expiry are re-checked atomically so paused/edited/deleted watches drop in-flight results. Commits also require the caller's unexpired worker lease (`_holder`). Watch mutations are compare-and-swap on revision. The VAPID seed lives in the private DB schema (service-role-only `signal_push_seed()`), push endpoints are restricted to real browser push providers, and the service worker builds its own navigation from a validated alert UUID.
- Flight Recorder records are written by the shared runner (`useTx.tsx` → `src/lib/recorder-store.ts`) — every route gets evidence without per-page wiring; records never contain RPC URLs or signed bytes.
- Rebalance Planner pure identities/ranges/assumptions live in `planner.ts`, read-only unsigned builds in `planner-chain.ts`, and UI in `RebalancePlanner.tsx`. Comparisons, detailed options and selections are immutable new Recorder facts, never executable imports. Same-pool reviews may explicitly widen; pool moves remain separately approved withdrawal/deposit stages with linked evidence. Preserve source range/active, form, rule/watch and wallet identity invalidation, 120s comparisons, 20s reviews, fee caps and JobControl drain latches. `asyncSemanticGuard` verifies current private watches before signing and after wallet approval; unknown/changed watches discard the signed transaction before broadcast.

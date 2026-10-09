# Developer SDK release · v0.2.0

The Developer Station at `/developers` exposes a small typed client, versioned read-only API and official MCP server. Source package: `packages/sdk`. SDK usage, contract limits and stdio configuration are in its README.

## Distribution

Install: `npm install https://studioloco.cfd/api/public/loco/v1/sdk/0.2.0.tgz`.

This package is distributed directly by Loco, not through the npm registry. Its exact archive is built from package source/declarations/README/license/examples by `npm run sdk:release`, then carried in a UTF-8 release manifest for the GitHub/Lovable deployment. No environment, wallet files, Recorder exports or QA output are included.

Archive: 14842 bytes. SHA-256: `3647f8dbf6269327eba4f5ac561b2cc4b31066c99e3c9ce9e98ed8a0620b7698`. The download returns the same value in `X-Checksum-Sha256`.

## Public reads

GET `/api/public/loco/v1/capabilities`, `/pools`, `/pools/{address}`, `/positions/{address}?pool=...`; specification at `/openapi.json`. Methods other than reads are rejected. Unknown/repeated query parameters fail. Mainnet-only fixed upstreams; 15-second end-to-end deadline, 2 MB upstream response cap, per-isolate concurrency cap. Pool list cap: pages 1–20 and 25 rows. `hasMore` describes the index even at the supported page cap; `dropped` reports invalid upstream rows. Missing metrics are null. No automatic fixture fallback, upstream retries or arbitrary RPC forwarding.

Position verification uses mainnet genesis and one confirmed pool/PositionV2 account context. Both program owners and SDK-derived discriminators are checked, the position must bind to the requested pool, and the actual owner/mints/range are decoded using the official IDL. Mints are read at or above that slot and checked for token program, initialization and decimals. This is a bounded observation, without holdings, fee earnings or any execution authorization.

## MCP and local helpers

Hosted endpoint `/api/public/loco/v1/mcp` uses official MCP TypeScript server 2.3.1 with the web-standard handler, modern 2026-07-28 and stateless legacy 2025 transports. Seven actual read-only tools: capabilities, list pools, get pool, get position, range geometry, blueprint inspection and protocol adapter registry. Browser Origin validation, 16 KiB MCP request cap and no private cloud authentication or export tool. Stdout is JSON-RPC only in the packaged `loco-mcp` stdio executable.

Local range geometry preserves exact odd/even width and a 69-bin limit. It is explicitly non-executable and not a native transaction simulation. The complete app Rebalance Planner still performs native simulation, cost checks and a fresh wallet review.

Flight Recorder and SDK use one strict schema. `analyzeRecorderExport` accepts explicitly supplied v1 exports locally, bounded to 5 MB / 2,000 records; returns aggregate acceptance, duplicate, link and confirmation-consistency counts. It neither emits private text nor independently verifies receipts or PnL. Local stdio can explicitly enable the eighth export-analysis tool with `--local-evidence`; hosted MCP never registers it.

## Validation before publishing

The previous client release passed 309 tests across 28 files. Source and QA TypeScript checks and production Worker build passed. Isolated archive installation and real official MCP client discovery/calls succeeded over stdio and modern HTTP; legacy initialize/list/call is covered in tests. Live Meteora pool list/detail reads were checked. IDL-coded PositionV2 fixtures verify matching pool/slot/mints and fail wrong genesis or pool bindings. Release acceptance performs only reads; no funds are moved.

Deployment is synchronized through a forward commit on the existing connected GitHub main branch, then Lovable publishes. Validate the public package checksum, pool/position API, remote MCP discovery/calls and Developer Station interactions after publication. Keep private QA artifacts outside the public commit.

## Browser and Worker patch

v0.1.1 fixed binding for both native and supplied fetch functions to the global receiver and sends credentials=omit only in browser contexts. Server upstream requests omit that unsupported Worker field and construct their own headers without forwarding cookies or authorization. The original 0.1.0 archive remains immutable at its existing URL; the Developer Station now installs 0.2.0; both older archives remain immutable. Live mainnet position verification and modern HTTP MCP pool reads also passed before publication.

## v0.2.0 · Strategy Foundry

Shared blueprint v1 schema, exact u64 decimal amounts, deterministic SHA-256 digests, integer nominal allocations, relative order ladders and a read-only adapter registry. `inspectBlueprint` does not fetch chain state, access a device library, build an executable transaction or authorize signing. `loco_inspect_blueprint` and `loco_protocol_adapters` are available over hosted and stdio MCP. See `docs/STRATEGY_FOUNDRY.md` for the app adapter and release acceptance.

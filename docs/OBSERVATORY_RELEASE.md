# The Observatory — acceptance and public release

This update fixes native Meteora DLMM rebalance preparation and supplies reproducible acceptance checks. Funded devnet acceptance passed all six strategy/width cases with 27 confirmed transactions and no unresolved signatures. The verified application commit `b8a11bd7` is now public at [The Observatory](https://studioloco.cfd/app/agents). Production desktop UI and real read-only mainnet loading passed verification.

## What changed

- Native target ranges preserve the original position's exact bin count. Explicit public SDK strategy parameters replace the convenience balanced helper that grew even widths by one bin.
- A changed SDK active-bin snapshot, a token top-up or a target that redeposits no liquidity is refused. Network fees and upfront SOL account rent still require wallet funds.
- The review's 20-second approval window starts after preparation and simulation finish. It remains bound to rule, wallet, network, RPC, position, target and slippage before and after approval.
- Native instruction composition can take up to 45 seconds. Wallet-provider RPC requests have a 15-second deadline covering headers and body. Timeouts continue to drain through JobControl; HTTP 429 is not automatically retried.
- Existing WSOL accounts stay open. Multi-transaction percentage withdrawals remain blocked in Agents before the first signature. Unknown costs, failed simulation and unresolved settlement disable approval.

The agent proposes rule-based actions while its tab is visible. Each product action requires wallet approval. This is ordinary DLMM; DLMM Pro and a background keeper are not integrated. Practice fixtures and watch-only views cannot transact.

## Evidence and limits

| Check | Result | Evidence |
|---|---|---|
| Unit regression suite | 172 passing tests in 14 files | Review timing, exact widths, active-state mismatch, empty redeposit, RPC cancellation and existing guard tests |
| Product and QA TypeScript | Pass | Both source and harness projects, zero errors |
| Production build | Pass | Client and Worker outputs |
| Native Spot, 46 bins | Unsigned mainnet simulation passed | [Exact RPC simulation and decoded post-state](qa/native-mainnet-even-Spot.json) |
| Native BidAsk, 46 bins | Unsigned mainnet simulation passed | [Exact RPC simulation and decoded post-state](qa/native-mainnet-even-BidAsk.json) |
| Native Curve, 46 bins | Unsigned mainnet simulation passed | [Exact RPC simulation and decoded post-state](qa/native-mainnet-even-Curve.json) |
| Native Curve, 69 bins | Amount-slippage refusal; no signature | [Retained first refusal](qa/native-mainnet-odd-Curve-slippage-refusal.json), [fresh recheck](qa/native-mainnet-odd-Curve.json) |
| Funded devnet matrix | Pass — six cases, 27 confirmed transactions | [Confirmed receipts and post-state checks](qa/funded-devnet-acceptance.json) |
| First setup attempt | SDK helper closed WSOL; subsequent simulation refused | [Preserved failure and its two confirmed setup receipts](qa/funded-devnet-setup-refusal.json) |
| Funded mainnet/browser-wallet acceptance | Not performed | No mainnet funds used; dedicated devnet signing is verified separately |
| Current preview runtime check | Pass in Lovable dev runtime, 1280/390 px | [Five routes, wallet dialog, practice flows, exact Apply→Arm and real watch-only positions](qa/preview-ui-verification.json); no page errors/document overflow |
| Current local Worker smoke | Not completed | Wrangler startup hit an environment system error; production bundling passed |
| Publication of this update | Published and browser-verified | [Production evidence](qa/production-verification.json); six routes, hydration, 10 real watch-only positions and live RPC/program reads |

The mainnet harness uses real public positions with signature verification disabled for simulation. Its broadcast methods throw, and it has no signer. Successful post-state checks verify range, owner and pool; they do not demonstrate settlement or ownership. Fees and compute are measurements of those specific messages, not fixed product costs. A protocol slippage error is a refusal to sign, not a successful rebalance.

## Dedicated devnet session

The wallet for this workspace is:

```
FpebsUzBXJ9PLAkFi1Kq4wEPHtyRPznh5e5FpdztpZQZ
```

The user funded this wallet with **0.5 DEVNET SOL**. The initial automated faucet HTTP 429 is retained as historical evidence and was not bypassed. A new QA wallet can request test SOL at https://faucet.solana.com. The successful run ended with 0.32621584 unwrapped devnet SOL; preserved WSOL and setup accounts remain test fixtures. The report records 170000 lamports of network fees separately from account rent and token balances.

This keypair was generated only for devnet acceptance and is stored in the ignored `.qa/` directory in this workspace. Its secret is never printed, committed, uploaded or requested from the user. A fresh checkout creates its own dedicated devnet wallet and prints that wallet's funding requirement instead. Do not import a real wallet key.

## Reproduce the checks

Use the installed lockfile dependencies and run from the repository root:

```sh
npm test -- --maxWorkers=2
npx tsc --noEmit -p .
npx tsc --noEmit -p scripts/qa/tsconfig.json
npm run build

# Read-only. These commands cannot broadcast.
LOCO_QA_EVEN=1 npm run qa:mainnet
LOCO_QA_EVEN=1 LOCO_QA_STRATEGY=BidAsk npm run qa:mainnet
LOCO_QA_STRATEGY=Curve npm run qa:mainnet

# Signs only with this harness's dedicated devnet keypair, after funding.
npm run qa:devnet
```

Network acceptance tests are excluded from the default unit suite. The devnet harness has a hardcoded devnet endpoint, validates the genesis hash and deployed DLMM program first, and has no mainnet configuration switch. It will stop before signing if its balance is below 0.35 devnet SOL. The 0.5 devnet SOL funding target leaves room for test account rent and fees.

The funded harness creates a synthetic token, a WSOL account and an isolated DLMM pool. Pool creation explicitly disables the SDK's automatic SOL wrapping/closing. It can reuse its own saved devnet fixture after verifying network/wallet, deterministic pool address, mint authority and confirmed setup receipts. For each combination of **20/21 bins × Spot/Curve/BidAsk**, it creates an out-of-range one-sided position, performs the native move, checks the confirmed range/width/owner, withdraws 25% and checks exact per-bin liquidity-share reduction, then explicitly removes the remainder and closes the position. It verifies that the existing WSOL account survives. Pool and token accounts may remain as devnet test fixtures; the script does not imply a full refund of all setup rent.

All chain writes use `src/lib/tx.ts`: cluster verification, fresh blockhash, exact simulation, dedicated wallet signature, signed-message checks, persistent pending records and confirmation. Native/withdrawal reviews also enforce the fee cap and readiness/deadline guards. Setup and cleanup have their own simulation and confirmation. A receipt is recorded only after the confirmed transaction's metadata reports no error.

On a timeout or unknown settlement, **stop**. Use the recorded signature to establish its final status before rerunning. Pending records survive in `.qa/devnet-pending.json`; the harness reconciles confirmed/expired records and blocks unknown ones, without automatic resending. Inspect any partially created devnet fixtures before cleanup.

## Funded acceptance gate

- [x] `qa:devnet` reports `passed: true`, all six shape/width cases have confirmed native, withdrawal and cleanup receipts, exact post-state assertions pass and no pending signature remains.
- [x] Recorded fees, balance changes and residual devnet fixtures reviewed; no mainnet signing or transaction occurred.
- [x] Lovable dev runtime verified no-wallet and watch-only entry/invalid-input paths and explicit practice rules, arm, monitoring start/pause, proposals and review cancellation at 1280/390 px. Five routes returned 200 with no page errors or document overflow. Exact Apply→Arm→Disarm passed; the earlier loose locator had selected the position card. Real watch-only data loaded eight mainnet positions with correct out-of-range status and spending controls disabled.
- [ ] A browser wallet rehearsal remains a separate manual check: a devnet wallet rejects a review, approves a fresh review and encounters a deliberately expired review. Confirmed success must link to the landed transaction. If this has not been exercised, retain that limitation in the release notes.

## Publish and verify

The user has already requested public release. No second publication approval is needed once the acceptance gate passes. Sync the reviewed commit to `jjyaz/studio-loco` without rewriting history, wait for Lovable to build that exact commit, then publish the existing project.

This release is published and desktop-verified on the custom domain. `/`, `/app`, `/app/agents`, `/app/dispatch`, `/docs` and `/network` rendered without document overflow. Wallet modal keyboard behavior and explicit practice Run check proved hydration. Real watch-only loading returned 10 verified mainnet positions, live ranges/holdings and same-pair comparisons; spending controls remained disabled. The status page returned a live slot/block height, an executable DLMM account and a healthy Data API. Its UI does not display genesis, so a direct production genesis lookup is not claimed. No application error-level console messages were captured; unrelated browser-extension errors were recorded separately. [Full production findings](qa/production-verification.json) and [screenshot](qa/observatory-live-release-1791412927834.jpg).

The production browser pass was desktop only. Mobile (390px) passed separately in Lovable dev runtime, and connected browser-wallet signing remains a separate unperformed rehearsal. The app clearly discloses ordinary DLMM, visible-tab monitoring and wallet approval for every action. A read-only production check does not replace the funded devnet acceptance or demonstrate funded mainnet settlement.

If the release build fails or production regresses, retain the failed evidence and restore the last known working deployment with a new forward commit. Never rewrite published Git history or label simulated transactions as funded results.

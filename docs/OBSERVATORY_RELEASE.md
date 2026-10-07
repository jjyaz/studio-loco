# The Observatory — acceptance and public release

This update fixes native Meteora DLMM rebalance preparation and supplies reproducible acceptance checks. Public release follows confirmed funded testing. It has not been published by this pass.

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
| Funded devnet matrix | Not executed; wallet balance zero | [Funding gate](qa/funded-devnet-acceptance.json), [faucet HTTP 429](qa/devnet-faucet.json) |
| Funded mainnet/browser-wallet acceptance | Not performed | No mainnet funds used and no signatures claimed |
| Publication of this update | Pending funded acceptance | Connected Lovable preview is the review target |

The mainnet harness uses real public positions with signature verification disabled for simulation. Its broadcast methods throw, and it has no signer. Successful post-state checks verify range, owner and pool; they do not demonstrate settlement or ownership. Fees and compute are measurements of those specific messages, not fixed product costs. A protocol slippage error is a refusal to sign, not a successful rebalance.

## Fund the dedicated devnet session

The wallet for this workspace is:

```
FpebsUzBXJ9PLAkFi1Kq4wEPHtyRPznh5e5FpdztpZQZ
```

Request **0.5 DEVNET SOL** at https://faucet.solana.com. The automated public faucet returned its airdrop-limit/dry-faucet response; it will not be retried through alternate identities or endpoints. Test SOL is required, not mainnet SOL.

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

The funded harness creates a synthetic token, a WSOL account and an isolated DLMM pool. For each combination of **20/21 bins × Spot/Curve/BidAsk**, it creates an out-of-range one-sided position, performs the native move, checks the confirmed range/width/owner, withdraws 25% and checks exact per-bin liquidity-share reduction, then explicitly removes the remainder and closes the position. It verifies that the existing WSOL account survives. Pool and token accounts may remain as devnet test fixtures; the script does not imply a full refund of all setup rent.

All chain writes use `src/lib/tx.ts`: cluster verification, fresh blockhash, exact simulation, dedicated wallet signature, signed-message checks, persistent pending records and confirmation. Native/withdrawal reviews also enforce the fee cap and readiness/deadline guards. Setup and cleanup have their own simulation and confirmation. A receipt is recorded only after the confirmed transaction's metadata reports no error.

On a timeout or unknown settlement, **stop**. Use the recorded signature to establish its final status before rerunning. Pending records survive in `.qa/devnet-pending.json`; the harness reconciles confirmed/expired records and blocks unknown ones, without automatic resending. Inspect any partially created devnet fixtures before cleanup.

## Funded acceptance gate

- [ ] `qa:devnet` reports `passed: true`, all six shape/width cases have confirmed native and withdrawal receipts, exact post-state assertions pass and no pending signature remains.
- [ ] Review the recorded fees, balance changes and residual fixtures; no unexplained mainnet call or transaction is acceptable.
- [ ] In the Lovable preview, check the no-wallet, watch-only and practice paths at mobile and desktop widths. Verify rules, monitoring start/pause and review cancellation. Do not emulate a funded wallet as evidence.
- [ ] A browser wallet rehearsal remains a separate manual check: a devnet wallet rejects a review, approves a fresh review and encounters a deliberately expired review. Confirmed success must link to the landed transaction. If this has not been exercised, retain that limitation in the release notes.

## Publish and verify

The user has already requested public release. No second publication approval is needed once the acceptance gate passes. Sync the reviewed commit to `jjyaz/studio-loco` without rewriting history, wait for Lovable to build that exact commit, then publish the existing project.

After publication, verify `/`, `/app`, `/app/agents`, `/app/dispatch` and `/docs`; mobile/desktop hydration and navigation; the production relay's genesis/program reads; and no-wallet actions. Confirm the release's ordinary-DLMM scope, visible-tab monitoring and wallet-approval requirement are accurately disclosed. A read-only production check does not replace funded acceptance.

If the release build fails or production regresses, retain the failed evidence and restore the last known working deployment with a new forward commit. Never rewrite published Git history or label simulated transactions as funded results.

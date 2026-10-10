/** Read-only mainnet adapter. Target addresses come from receipts or explicit watch inputs. */
import { Buffer } from "buffer";
import type { Connection } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import { assertCluster } from "./tx";
import { verifyDlmmAccount } from "./account-verify";
import { DLMM_PROGRAM, type Blueprint } from "./foundry";
import type { Job } from "./job-control";
import type { FlightRecord } from "./recorder";
import {
  JourneyIdentity,
  JourneySnapshot,
  validateCandidate,
  transactionProof,
  type Journey,
  type JourneyLink,
} from "./journey";
const T = 15_000;
/** SDK LP pro-rata amounts are fractional raw units: floor with decimal-string arithmetic. */
export function floorRaw(input: string): string {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input);
  if (!m || input.length > 180) throw new Error("Invalid SDK amount.");
  const digits = m[1]! + (m[2] ?? ""),
    shift = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 180)
    throw new Error("SDK amount exponent exceeds bounds.");
  const integer =
    shift >= 0 ? digits + "0".repeat(shift) : digits.slice(0, Math.max(0, digits.length + shift));
  const result = (integer || "0").replace(/^0+(?=\d)/, "");
  if (result.length > 60) throw new Error("SDK amount exceeds bounds.");
  return result;
}
/** Order SDK values are UI units; restore integer base units without Number/rounding. */
export function orderRaw(input: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Invalid decimals.");
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input);
  if (!m) throw new Error("Invalid order amount.");
  const shifted = `${m[1]}${m[2] ? `.${m[2]}` : ""}e${Number(m[3] ?? 0) + decimals}`;
  const n = floorRaw(shifted);
  // Values originate in integer chain units. Nonzero sub-unit precision is a malformed SDK view.
  const digits = m[1]! + (m[2] ?? ""),
    shift = Number(m[3] ?? 0) + decimals - (m[2]?.length ?? 0);
  if (shift < 0 && /[1-9]/.test(digits.slice(Math.max(0, digits.length + shift))))
    throw new Error("Order amount has sub-unit precision.");
  return n;
}
export async function readJourneySnapshot(
  connection: Connection,
  input: JourneyIdentity,
  job: Job,
  source: "relay" | "custom" | "server",
  previous?: JourneySnapshot,
  minimumSlot = 0,
  budgetMs = 65_000,
): Promise<JourneySnapshot> {
  const caller = job,
    deadline = Date.now() + Math.max(1, Math.min(budgetMs, 65_000));
  job = {
    ...caller,
    check() {
      caller.check();
      if (Date.now() >= deadline) throw new Error("Journey read exceeded its overall deadline.");
    },
    async step(p, ms, label) {
      const result = await caller.step(p, Math.max(1, Math.min(ms, deadline - Date.now())), label);
      job.check();
      return result;
    },
  };
  const i = JourneyIdentity.parse({
    kind: input.kind,
    account: input.account,
    pool: input.pool,
    owner: input.owner,
  });
  const { PublicKey } = await import("@solana/web3.js");
  await job.step(assertCluster(connection, "mainnet-beta"), T, "Mainnet genesis");
  const sdk = await job.step(loadSdk(), T, "Meteora SDK");
  const poolKey = new PublicKey(i.pool),
    accountKey = new PublicKey(i.account),
    owner = new PublicKey(i.owner);
  const raw = await job.step(
    connection.getMultipleAccountsInfoAndContext([poolKey, accountKey], {
      commitment: "confirmed",
      minContextSlot: Math.max(minimumSlot, previous?.checkedSlot ?? 0),
    }),
    T,
    "Journey account verification",
  );
  const [pairInfo, accountInfo] = raw.value;
  if (raw.context.slot < Math.max(minimumSlot, previous?.checkedSlot ?? 0))
    throw new Error("RPC returned an observation below the required slot.");
  const disc = new Uint8Array(
    sdk.getAccountDiscriminator(i.kind === "position" ? "positionV2" : "limitOrder"),
  );
  if (
    !pairInfo ||
    pairInfo.executable ||
    pairInfo.owner.toBase58() !== DLMM_PROGRAM ||
    !new Uint8Array(sdk.getAccountDiscriminator("lbPair")).every(
      (v, index) => pairInfo.data[index] === v,
    )
  )
    throw new Error("Pool program or LbPair discriminator failed verification.");
  if (!accountInfo)
    throw new Error(
      "Account is absent at this confirmed read. Filled or closed cannot be inferred; previous evidence is kept.",
    );
  if (
    accountInfo.executable ||
    !verifyDlmmAccount(accountInfo, {
      programId: DLMM_PROGRAM,
      discriminator: disc,
      lbPair: poolKey.toBytes(),
      owner: owner.toBytes(),
    })
  )
    throw new Error("Account program, type, pool or owner failed verification.");
  const pool = await job.step(
    sdk.default.create(connection, poolKey, {
      cluster: "mainnet-beta",
      skipSolWrappingOperation: true,
    }),
    T,
    "Fresh Journey pool",
  );
  const pair = pool.program.coder.accounts.decode(
    "lbPair",
    Buffer.from(pairInfo.data),
  ) as typeof pool.lbPair;
  if (
    !pool.program.programId.equals(new PublicKey(DLMM_PROGRAM)) ||
    !pool.pubkey.equals(poolKey) ||
    !pair.tokenXMint.equals(pool.tokenX.publicKey) ||
    !pair.tokenYMint.equals(pool.tokenY.publicKey) ||
    pair.binStep !== pool.lbPair.binStep
  )
    throw new Error("Fresh pool identity differs from the verified account.");
  const spl = await import("@solana/spl-token");
  const mintRead = await job.step(
    connection.getMultipleAccountsInfoAndContext([pair.tokenXMint, pair.tokenYMint], {
      commitment: "confirmed",
      minContextSlot: raw.context.slot,
    }),
    T,
    "Journey mint verification",
  );
  const decs = mintRead.value.map((info, index) => {
    if (
      !info ||
      info.executable ||
      (!info.owner.equals(spl.TOKEN_PROGRAM_ID) && !info.owner.equals(spl.TOKEN_2022_PROGRAM_ID))
    )
      throw new Error("Mint program is unverified.");
    const mint = spl.unpackMint(index === 0 ? pair.tokenXMint : pair.tokenYMint, info, info.owner);
    if (
      !mint.isInitialized ||
      mint.decimals > 18 ||
      mint.decimals !== (index === 0 ? pool.tokenX.mint.decimals : pool.tokenY.mint.decimals)
    )
      throw new Error("Mint precision is unverified.");
    return mint.decimals;
  });
  const rent = await job.step(
    connection.getMinimumBalanceForRentExemption(accountInfo.data.length),
    T,
    "Account rent minimum",
  );
  if (!Number.isSafeInteger(accountInfo.lamports) || !Number.isSafeInteger(rent) || rent < 0)
    throw new Error("Account SOL or rent minimum is invalid.");
  const base = {
    observedAt: Date.now(),
    slot: raw.context.slot,
    checkedSlot: raw.context.slot,
    source,
    mintX: pair.tokenXMint.toBase58(),
    mintY: pair.tokenYMint.toBase58(),
    decX: decs[0]!,
    decY: decs[1]!,
    binStep: pair.binStep,
    activeId: pair.activeId,
    accountLamports: String(accountInfo.lamports),
    rentMinimumLamports: String(rent),
  };
  let result: JourneySnapshot;
  if (i.kind === "position") {
    const pos = await job.step(pool.getPosition(accountKey), T, "Position holdings and fees");
    const p = pos.positionData;
    const wrapped = sdk.wrapPosition(pool.program, accountKey, accountInfo);
    if (
      !pos.publicKey.equals(accountKey) ||
      !p.owner.equals(owner) ||
      !p.feeOwner.equals(wrapped.feeOwner()) ||
      p.lowerBinId !== wrapped.lowerBinId().toNumber() ||
      p.upperBinId !== wrapped.upperBinId().toNumber() ||
      !p.totalClaimedFeeXAmount.eq(wrapped.totalClaimedFeeXAmount()) ||
      !p.totalClaimedFeeYAmount.eq(wrapped.totalClaimedFeeYAmount())
    )
      throw new Error("Processed position differs from the verified account.");
    result = JourneySnapshot.parse({
      ...base,
      kind: "position",
      lower: p.lowerBinId,
      upper: p.upperBinId,
      holdingsX: floorRaw(p.totalXAmount),
      holdingsY: floorRaw(p.totalYAmount),
      feeOwner: p.feeOwner.toBase58(),
      feeX: p.feeX.toString(),
      feeY: p.feeY.toString(),
      claimedX: p.totalClaimedFeeXAmount.toString(),
      claimedY: p.totalClaimedFeeYAmount.toString(),
      bins: p.positionBinData.map((b) => ({
        binId: b.binId,
        x: floorRaw(b.positionXAmount),
        y: floorRaw(b.positionYAmount),
        shares: b.positionLiquidity,
      })),
    });
  } else {
    const order = await job.step(pool.getLimitOrder(accountKey), T, "Native order levels");
    if (!order.publicKey.equals(accountKey))
      throw new Error("Order address differs from its verified account.");
    const o = order.limitOrderData,
      x = (v: string) => orderRaw(v, decs[0]!),
      y = (v: string) => orderRaw(v, decs[1]!);
    result = JourneySnapshot.parse({
      ...base,
      kind: "order",
      holdingsX: x(o.transferFeeExcludedWithdrawableAmountX),
      holdingsY: y(o.transferFeeExcludedWithdrawableAmountY),
      feeX: x(o.totalFeeAmountX),
      feeY: y(o.totalFeeAmountY),
      unfilledX: x(o.totalUnfilledAmountX),
      unfilledY: y(o.totalUnfilledAmountY),
      filledX: x(o.totalFilledAmountX),
      filledY: y(o.totalFilledAmountY),
      proceedsX: x(o.totalSwappedAmountX),
      proceedsY: y(o.totalSwappedAmountY),
      levels: o.limitOrderBinData
        .filter((b) => !b.empty)
        .map((b) => {
          if (![0, 1, 2].includes(b.status)) throw new Error("Unrecognized native order status.");
          return {
            binId: b.binId,
            side: b.isAskSide ? "sell" : "buy",
            state: ["resting", "partial", "filled"][b.status],
            depositX: x(b.depositAmountX),
            depositY: y(b.depositAmountY),
            unfilledX: x(b.unfilledAmountX),
            unfilledY: y(b.unfilledAmountY),
            filledX: x(b.filledAmountX),
            filledY: y(b.filledAmountY),
            proceedsX: x(b.swappedAmountX),
            proceedsY: y(b.swappedAmountY),
          };
        }),
    });
  }
  // The SDK uses multiple confirmed reads. Corroborate the target bytes and disclose the window;
  // changing accounts are retried by the user, rather than silently merging incompatible views.
  const checked = await job.step(
    connection.getAccountInfoAndContext(accountKey, {
      commitment: "confirmed",
      minContextSlot: Math.max(raw.context.slot, mintRead.context.slot),
    }),
    T,
    "Snapshot corroboration",
  );
  if (
    !checked.value ||
    !checked.value.owner.equals(accountInfo.owner) ||
    !Buffer.from(checked.value.data).equals(Buffer.from(accountInfo.data)) ||
    checked.value.lamports !== accountInfo.lamports
  )
    throw new Error("Account changed during observation. Refresh for a coherent account view.");
  result = JourneySnapshot.parse({
    ...result,
    observedAt: Date.now(),
    checkedSlot: checked.context.slot,
  });
  if (checked.context.slot < Math.max(raw.context.slot, mintRead.context.slot))
    throw new Error("RPC corroboration moved backwards.");
  if (
    previous &&
    (previous.mintX !== result.mintX ||
      previous.mintY !== result.mintY ||
      previous.binStep !== result.binStep)
  )
    throw new Error("Watched pool identity changed.");
  job.check();
  return result;
}
export async function verifyFoundryLink(
  connection: Connection,
  record: FlightRecord,
  blueprint: Blueprint,
  digest: string,
  job: Job,
  source: "relay" | "custom",
) {
  const c = await job.step(
    validateCandidate(record, blueprint, digest),
    T,
    "Blueprint receipt integrity",
  );
  await job.step(assertCluster(connection, "mainnet-beta"), T, "Mainnet genesis");
  const tx = await job.step(
    connection.getTransaction(c.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
    T,
    "Confirmed action metadata",
  );
  const sdk = await job.step(loadSdk(), T, "Foundry instruction identity");
  const ix = sdk.IDL.instructions.find(
    (i) => i.name === (c.action === "liquidity" ? "add_liquidity_by_weight2" : "place_limit_order"),
  );
  if (!ix) throw new Error("Foundry instruction is absent from the verified SDK IDL.");
  const proof = transactionProof(tx, c, new Uint8Array(ix.discriminator));
  const snapshot = await readJourneySnapshot(connection, c, job, source, undefined, proof.slot);
  if (
    snapshot.mintX !== blueprint.mintX ||
    snapshot.mintY !== blueprint.mintY ||
    snapshot.binStep !== blueprint.binStep
  )
    throw new Error("Resulting account's pool differs from this blueprint revision.");
  const link: JourneyLink = {
    recordId: record.id,
    signature: c.signature,
    slot: proof.slot,
    blueprintId: blueprint.id,
    revision: blueprint.revision,
    digest,
    name: blueprint.name,
    action: c.action,
    feeLamports: proof.feeLamports,
  };
  return {
    identity: JourneyIdentity.parse({
      kind: c.kind,
      account: c.account,
      pool: c.pool,
      owner: c.owner,
    }),
    snapshot,
    link,
  };
}
export function verifiedNetworkFees(j: Journey) {
  return [...new Map(j.links.map((l) => [l.signature, l])).values()]
    .reduce((sum, l) => sum + BigInt(l.feeLamports), 0n)
    .toString();
}

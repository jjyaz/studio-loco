/** Native Foundry adapter. Builds and simulates; only the shared wallet runner signs or sends. */
import BN from "bn.js";
import { Buffer } from "buffer";
import type {
  AccountInfo,
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import { assertCluster } from "./tx";
import { verifyDlmmAccount } from "./account-verify";
import { reviewCosts, NATIVE_BUILD_TIMEOUT_MS, type CostReview } from "./agents-chain";
import type { Job } from "./job-control";
import {
  blueprintDigest,
  compileBlueprint,
  DLMM_PROGRAM,
  foundryCostRefusal,
  nativeFoundryWeights,
  parseBlueprint,
  type Blueprint,
  type BlueprintAction,
  type CompiledBlueprint,
} from "./foundry";
const T = 12_000;
export interface FoundryPoolSnapshot {
  address: string;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;
  tokenProgramX: string;
  tokenProgramY: string;
  binStep: number;
  activeBinId: number;
  slot: number;
  observedAt: number;
  baseFeeBps: number;
  variableFeeBps: number;
  totalFeeBps: number;
  maxFeeBps: number;
  protocolShareBps: number;
  feeCurrency: "input" | "token-y";
  functionType: number;
  limitOrders: boolean;
  enabled: boolean;
  activated: boolean;
  supportedMints: boolean;
  mintNotes: string[];
}
function verifiedPoolAccount(info: AccountInfo<Buffer> | null, discriminator: Uint8Array) {
  if (
    !info ||
    info.executable ||
    info.owner.toBase58() !== DLMM_PROGRAM ||
    discriminator.length !== 8 ||
    !discriminator.every((v, i) => info.data[i] === v)
  )
    throw new Error("The address is not a verified ordinary Meteora DLMM pool.");
}
export async function readFoundryPool(connection: Connection, address: string, job: Job) {
  const { PublicKey, SYSVAR_CLOCK_PUBKEY } = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  job.check();
  await job.step(assertCluster(connection, "mainnet-beta"), T, "Mainnet genesis");
  const sdk = await job.step(loadSdk(), T, "Meteora SDK");
  const key = new PublicKey(address);
  const raw = await job.step(
    connection.getAccountInfoAndContext(key, "confirmed"),
    T,
    "Pool account verification",
  );
  verifiedPoolAccount(raw.value, new Uint8Array(sdk.getAccountDiscriminator("lbPair")));
  const pool = await job.step(
    sdk.default.create(connection, key, {
      cluster: "mainnet-beta",
      skipSolWrappingOperation: true,
    }),
    T,
    "Fresh DLMM state",
  );
  if (!pool.program.programId.equals(new PublicKey(DLMM_PROGRAM)) || !pool.pubkey.equals(key))
    throw new Error("The SDK returned a different pool or program.");
  const pair = pool.lbPair;
  if (
    pair.tokenXMint.equals(pair.tokenYMint) ||
    !Number.isInteger(pair.binStep) ||
    pair.binStep <= 0 ||
    !Number.isInteger(pair.activeId)
  )
    throw new Error("The pool's mint pair or bin parameters are invalid.");
  const infos = await job.step(
    connection.getMultipleAccountsInfo(
      [pair.tokenXMint, pair.tokenYMint, SYSVAR_CLOCK_PUBKEY],
      "confirmed",
    ),
    T,
    "Mint and activation verification",
  );
  const notes: string[] = [];
  const mints = [pair.tokenXMint, pair.tokenYMint].map((mint, i) => {
    const info = infos[i];
    if (
      !info ||
      info.executable ||
      (!info.owner.equals(spl.TOKEN_PROGRAM_ID) && !info.owner.equals(spl.TOKEN_2022_PROGRAM_ID))
    )
      throw new Error("A pool mint uses an unverified token program.");
    const decoded = spl.unpackMint(mint, info, info.owner);
    if (!decoded.isInitialized || decoded.decimals > 18)
      throw new Error("A pool mint is uninitialized or exceeds supported precision.");
    const types = spl.getExtensionTypes(decoded.tlvData);
    const supported = types.every(
      (t) => t === spl.ExtensionType.MetadataPointer || t === spl.ExtensionType.TokenMetadata,
    );
    if (!supported)
      notes.push(
        `Token ${i === 0 ? "X" : "Y"} has transfer/authority extensions that this adapter does not execute.`,
      );
    const expected = i === 0 ? pool.tokenX : pool.tokenY;
    if (
      !expected.mint.address.equals(mint) ||
      !expected.owner.equals(info.owner) ||
      expected.mint.decimals !== decoded.decimals
    )
      throw new Error("The SDK mint identity differs from its verified account.");
    return { decimals: decoded.decimals, program: info.owner.toBase58(), supported };
  });
  if (!infos[2]) throw new Error("The chain clock is unavailable.");
  const clock = sdk.ClockLayout.decode(infos[2].data);
  const chainTime = new BN(clock.unixTimestamp).toNumber();
  const chainSlot = new BN(clock.slot).toNumber();
  if (!Number.isSafeInteger(chainTime) || !Number.isSafeInteger(chainSlot))
    throw new Error("The chain clock could not be verified.");
  // Recalculate dynamic fees against Solana's clock, rather than the browser's wall clock.
  const v = { ...pair.vParameters };
  sdk.default.updateReference(pair.activeId, v, pair.parameters, chainTime);
  sdk.default.updateVolatilityAccumulator(v, pair.parameters, pair.activeId);
  const total = sdk.getTotalFee(pair.binStep, pair.parameters, v);
  const base = sdk.getBaseFee(pair.binStep, pair.parameters);
  const feeBps = (n: BN) => (n.toNumber() * 10_000) / sdk.FEE_PRECISION.toNumber();
  const info = pool.getFeeInfo();
  const totalFeeBps = feeBps(total),
    baseFeeBps = feeBps(base);
  const maxFeeBps = info.maxFeeRatePercentage.toNumber() * 100;
  const feeMode = pair.parameters.collectFeeMode;
  if (
    ![0, 1].includes(feeMode) ||
    [totalFeeBps, baseFeeBps, maxFeeBps].some((n) => !Number.isFinite(n) || n < 0 || n > 10_000)
  )
    throw new Error("The pool's fee configuration is unrecognized.");
  const activation = pair.activationPoint;
  if (![0, 1].includes(pair.activationType))
    throw new Error("The pool activation type is unrecognized.");
  const activated = activation.lte(new BN(pair.activationType === 0 ? chainSlot : chainTime));
  const snapshot: FoundryPoolSnapshot = {
    address,
    mintX: pair.tokenXMint.toBase58(),
    mintY: pair.tokenYMint.toBase58(),
    decimalsX: mints[0]!.decimals,
    decimalsY: mints[1]!.decimals,
    tokenProgramX: mints[0]!.program,
    tokenProgramY: mints[1]!.program,
    binStep: pair.binStep,
    activeBinId: pair.activeId,
    slot: raw.context.slot,
    observedAt: Date.now(),
    baseFeeBps,
    variableFeeBps: Math.max(0, totalFeeBps - baseFeeBps),
    totalFeeBps,
    maxFeeBps,
    protocolShareBps: pair.parameters.protocolShare,
    feeCurrency: feeMode === 0 ? "input" : "token-y",
    functionType: pair.parameters.functionType,
    limitOrders: sdk.isSupportLimitOrder(pair),
    enabled: pair.status === 0,
    activated,
    supportedMints: mints.every((m) => m.supported),
    mintNotes: notes,
  };
  return { snapshot, pool, sdk };
}
export function validateFoundryPool(
  snapshot: FoundryPoolSnapshot,
  blueprint: Blueprint,
  action: BlueprintAction,
): string | null {
  if (
    snapshot.address !== blueprint.pool ||
    snapshot.mintX !== blueprint.mintX ||
    snapshot.mintY !== blueprint.mintY ||
    snapshot.binStep !== blueprint.binStep
  )
    return "The verified pool and mint pair differ from the blueprint.";
  if (!snapshot.enabled || !snapshot.activated) return "The pool is disabled or has not activated.";
  if (!snapshot.supportedMints)
    return snapshot.mintNotes.join(" ") || "Mint extensions are not supported by this adapter.";
  if (
    !Number.isFinite(snapshot.totalFeeBps) ||
    snapshot.totalFeeBps < 0 ||
    snapshot.totalFeeBps > 10_000
  )
    return "The current pool fee is unavailable.";
  if (snapshot.totalFeeBps > blueprint.rules.maxTotalFeeBps)
    return "The current swap fee exceeds the blueprint's ceiling.";
  if (action !== "liquidity" && !snapshot.limitOrders)
    return "This pool does not support native limit orders.";
  return null;
}
export interface TokenFunding {
  address: PublicKey;
  pre: TransactionInstruction[];
  post: TransactionInstruction[];
  /** Include temporary-account rent even when simulation closes it and refunds it. */
  temporaryRentLamports: number;
  wrappedLamports: bigint;
}
export async function prepareFoundryToken(o: {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  job: Job;
}): Promise<TokenFunding> {
  const spl = await import("@solana/spl-token");
  const { SystemProgram } = await import("@solana/web3.js");
  o.job.check();
  const address = spl.getAssociatedTokenAddressSync(o.mint, o.owner, true, o.tokenProgram);
  const info = await o.job.step(
    o.connection.getAccountInfo(address, "confirmed"),
    T,
    "Token funding account",
  );
  const isNative = o.mint.equals(spl.NATIVE_MINT);
  let available = 0n;
  if (info) {
    if (!info.owner.equals(o.tokenProgram))
      throw new Error("The token funding account has a different program.");
    const account = spl.unpackAccount(address, info, o.tokenProgram);
    if (
      !account.mint.equals(o.mint) ||
      !account.owner.equals(o.owner) ||
      !account.isInitialized ||
      account.isFrozen ||
      (isNative && !account.isNative)
    )
      throw new Error("The token funding account is not a valid account for this wallet and mint.");
    available = account.amount;
  }
  if (!isNative && available < o.amount)
    throw new Error("The wallet's verified token balance is below this action's budget.");
  const pre: TransactionInstruction[] = [],
    post: TransactionInstruction[] = [];
  let temporaryRentLamports = 0;
  if (!info) {
    // Strict create for a temporary WSOL ATA: a race cannot close a pre-existing user account.
    pre.push(
      isNative
        ? spl.createAssociatedTokenAccountInstruction(
            o.owner,
            address,
            o.owner,
            o.mint,
            o.tokenProgram,
          )
        : spl.createAssociatedTokenAccountIdempotentInstruction(
            o.owner,
            address,
            o.owner,
            o.mint,
            o.tokenProgram,
          ),
    );
    if (isNative) {
      temporaryRentLamports = await o.job.step(
        o.connection.getMinimumBalanceForRentExemption(spl.ACCOUNT_SIZE),
        T,
        "Temporary WSOL rent",
      );
      post.push(spl.createCloseAccountInstruction(address, o.owner, o.owner, [], o.tokenProgram));
    }
  }
  const wrappedLamports = isNative && o.amount > available ? o.amount - available : 0n;
  if (wrappedLamports > 0n)
    pre.push(
      SystemProgram.transfer({ fromPubkey: o.owner, toPubkey: address, lamports: wrappedLamports }),
      spl.createSyncNativeInstruction(address, o.tokenProgram),
    );
  return { address, pre, post, temporaryRentLamports, wrappedLamports };
}
export interface FoundryBuild {
  blueprint: Blueprint;
  digest: string;
  action: BlueprintAction;
  snapshot: FoundryPoolSnapshot;
  compiled: CompiledBlueprint;
  tx: Transaction;
  signers: Signer[];
  account: string;
  newPosition: boolean;
  costs: CostReview;
  refusal: string | null;
  nativeWeights: { binId: number; weight: number }[];
  temporaryRentLamports: number;
  wrappedLamports: string;
  simulatedAccountVerified: boolean;
}
export async function buildFoundryAction(o: {
  connection: Connection;
  owner: PublicKey;
  blueprint: unknown;
  action: BlueprintAction;
  position?: string;
  job: Job;
}): Promise<FoundryBuild> {
  const { PublicKey, Keypair, Transaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } =
    await import("@solana/web3.js");
  o.job.check();
  const blueprint = parseBlueprint(o.blueprint),
    digest = await o.job.step(blueprintDigest(blueprint), T, "Blueprint digest");
  const { snapshot, pool, sdk } = await readFoundryPool(o.connection, blueprint.pool, o.job);
  const why = validateFoundryPool(snapshot, blueprint, o.action);
  if (why) throw new Error(why);
  const compiled = compileBlueprint(blueprint, {
    activeBinId: snapshot.activeBinId,
    decimalsX: snapshot.decimalsX,
    decimalsY: snapshot.decimalsY,
  });
  const ladder = compiled.ladders.find((l) => l.side === o.action);
  const amountX =
    o.action === "liquidity"
      ? BigInt(compiled.budgetXRaw)
      : o.action === "sell"
        ? BigInt(ladder?.totalRaw ?? "0")
        : 0n;
  const amountY =
    o.action === "liquidity"
      ? BigInt(compiled.budgetYRaw)
      : o.action === "buy"
        ? BigInt(ladder?.totalRaw ?? "0")
        : 0n;
  if (amountX + amountY === 0n) throw new Error("This action needs a non-zero budget.");
  const ix: TransactionInstruction[] = [],
    post: TransactionInstruction[] = [];
  // LP needs both ATAs; orders need only the funded leg. Never wrap or close an existing WSOL ATA.
  const funding: TokenFunding[] = [];
  for (const side of o.action === "liquidity" ? ["X", "Y"] : o.action === "sell" ? ["X"] : ["Y"]) {
    const f = await prepareFoundryToken({
      connection: o.connection,
      owner: o.owner,
      mint: side === "X" ? pool.lbPair.tokenXMint : pool.lbPair.tokenYMint,
      tokenProgram: side === "X" ? pool.tokenX.owner : pool.tokenY.owner,
      amount: side === "X" ? amountX : amountY,
      job: o.job,
    });
    funding.push(f);
    ix.push(...f.pre);
    post.push(...f.post);
  }
  const signers: Signer[] = [];
  let account: PublicKey;
  let newPosition = false;
  let nativeWeights: { binId: number; weight: number }[] = [];
  if (o.action === "liquidity") {
    if (o.position) {
      account = new PublicKey(o.position);
      const info = await o.job.step(
        o.connection.getAccountInfo(account, "confirmed"),
        T,
        "Position identity",
      );
      if (
        !verifyDlmmAccount(info, {
          programId: DLMM_PROGRAM,
          discriminator: new Uint8Array(sdk.getAccountDiscriminator("positionV2")),
          lbPair: pool.pubkey.toBytes(),
          owner: o.owner.toBytes(),
        })
      )
        throw new Error("The position is not owned by this wallet in this pool.");
      const pos = pool.program.coder.accounts.decode("positionV2", info!.data) as {
        lowerBinId: number;
        upperBinId: number;
      };
      if (pos.lowerBinId !== compiled.lowerBinId || pos.upperBinId !== compiled.upperBinId)
        throw new Error(
          "An existing position must match the exact compiled blueprint range. Create a new position or adjust the bins.",
        );
    } else {
      const signer = Keypair.generate();
      signers.push(signer);
      account = signer.publicKey;
      newPosition = true;
      ix.push(
        await o.job.step(
          pool.program.methods
            .initializePosition(compiled.lowerBinId, compiled.upperBinId - compiled.lowerBinId + 1)
            .accountsPartial({
              payer: o.owner,
              position: account,
              lbPair: pool.pubkey,
              owner: o.owner,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .instruction(),
          T,
          "Native position instruction",
        ),
      );
    }
    const indexes = sdk.getBinArrayIndexesCoverage(
      new BN(compiled.lowerBinId),
      new BN(compiled.upperBinId),
    );
    const extensionNeeded = indexes.some((i) => sdk.isOverflowDefaultBinArrayBitmap(i));
    const extension = extensionNeeded
      ? sdk.deriveBinArrayBitmapExtension(pool.pubkey, pool.program.programId)[0]
      : null;
    if (extension && !pool.binArrayBitmapExtension)
      ix.push(
        await o.job.step(
          pool.program.methods
            .initializeBinArrayBitmapExtension()
            .accountsPartial({
              binArrayBitmapExtension: extension,
              funder: o.owner,
              lbPair: pool.pubkey,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .instruction(),
          T,
          "Native bitmap instruction",
        ),
      );
    // Compose from the verified IDL. Convenience add-by-weight fetches an existing position,
    // which cannot be used for an atomic create + deposit.
    for (const index of indexes) {
      const [binArray] = sdk.deriveBinArray(pool.pubkey, index, pool.program.programId);
      const existing = await o.job.step(
        o.connection.getAccountInfo(binArray, "confirmed"),
        T,
        "Price-level account",
      );
      if (!existing)
        ix.push(
          await o.job.step(
            pool.program.methods
              .initializeBinArray(index)
              .accountsPartial({ binArray, funder: o.owner, lbPair: pool.pubkey })
              .instruction(),
            T,
            "Native bin-array instruction",
          ),
        );
      else if (
        !existing.owner.equals(pool.program.programId) ||
        !sdk.getAccountDiscriminator("binArray").every((v, i) => existing.data[i] === v)
      )
        throw new Error("A price-level account could not be verified.");
    }
    nativeWeights = nativeFoundryWeights(compiled.bins, (binId) =>
      BigInt(sdk.getQPriceFromId(new BN(binId), new BN(snapshot.binStep)).toString()),
    );
    const transfer = pool.getPotentialToken2022IxDataAndAccounts(sdk.ActionType.Liquidity);
    if (transfer.accounts.length)
      throw new Error("Transfer hooks are not enabled in this adapter.");
    const userTokenX = funding[0]!.address,
      userTokenY = funding[1]!.address;
    const maxActiveBinSlippage = Math.min(
      blueprint.rules.maxActiveBinDrift,
      Math.ceil(blueprint.rules.slippageBps / snapshot.binStep),
    );
    ix.push(
      await o.job.step(
        pool.program.methods
          .addLiquidityByWeight2(
            {
              amountX: new BN(amountX.toString()),
              amountY: new BN(amountY.toString()),
              activeId: snapshot.activeBinId,
              maxActiveBinSlippage,
              binLiquidityDist: nativeWeights,
            },
            { slices: transfer.slices },
          )
          .accountsPartial({
            position: account,
            lbPair: pool.pubkey,
            userTokenX,
            userTokenY,
            reserveX: pool.lbPair.reserveX,
            reserveY: pool.lbPair.reserveY,
            tokenXMint: pool.lbPair.tokenXMint,
            tokenYMint: pool.lbPair.tokenYMint,
            sender: o.owner,
            tokenXProgram: pool.tokenX.owner,
            tokenYProgram: pool.tokenY.owner,
            binArrayBitmapExtension: extension,
          })
          .remainingAccounts([
            ...transfer.accounts,
            ...sdk.getBinArrayAccountMetasCoverage(
              new BN(compiled.lowerBinId),
              new BN(compiled.upperBinId),
              pool.pubkey,
              pool.program.programId,
            ),
          ])
          .instruction(),
        T,
        "Native weighted deposit instruction",
      ),
    );
  } else {
    if (!ladder) throw new Error("This blueprint has no ladder on the selected side.");
    const signer = Keypair.generate();
    signers.push(signer);
    account = signer.publicKey;
    const order = await o.job.step(
      pool.placeLimitOrder({
        owner: o.owner,
        payer: o.owner,
        sender: o.owner,
        limitOrder: account,
        params: {
          isAskSide: o.action === "sell",
          relativeBin: null,
          bins: ladder.bins.map((b) => ({ id: b.binId, amount: new BN(b.amountRaw) })),
        },
      }),
      NATIVE_BUILD_TIMEOUT_MS,
      "Native order ladder",
    );
    ix.push(
      ...order.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)),
    );
  }
  const latest = await o.job.step(
    o.connection.getLatestBlockhash("confirmed"),
    T,
    "Review blockhash",
  );
  const tx = new Transaction({ ...latest, feePayer: o.owner }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...ix,
    ...post,
  );
  let simulatedAccountVerified = false;
  const costs = await reviewCosts(o.connection, o.owner, [tx], o.job, (keys, accounts) => {
    const state = accounts?.[keys.findIndex((k) => k.equals(account))];
    if (!state || state.data[1] !== "base64")
      throw new Error("The simulation did not return the target account. Approval is disabled.");
    const data = Buffer.from(state.data[0]!, "base64");
    const discriminator = new Uint8Array(
      sdk.getAccountDiscriminator(o.action === "liquidity" ? "positionV2" : "limitOrder"),
    );
    const acc = { owner: new PublicKey(state.owner), data };
    if (
      !verifyDlmmAccount(acc, {
        programId: DLMM_PROGRAM,
        discriminator,
        lbPair: pool.pubkey.toBytes(),
        owner: o.owner.toBytes(),
      })
    )
      throw new Error("The simulated account has the wrong program, pool or owner.");
    if (o.action === "liquidity") {
      const p = pool.program.coder.accounts.decode("positionV2", data) as {
        lowerBinId: number;
        upperBinId: number;
      };
      if (p.lowerBinId !== compiled.lowerBinId || p.upperBinId !== compiled.upperBinId)
        throw new Error("The simulated position differs from the blueprint's exact bounds.");
    } else {
      // Public SDK/IDL layout: 112-byte header + 32-byte LimitOrderBinData entries.
      const count = data.readUInt16LE(72),
        header = 8 + sdk.LIMIT_ORDER_MIN_SIZE;
      if (
        !ladder ||
        count !== ladder.bins.length ||
        data.length < header + count * sdk.LIMIT_ORDER_BIN_DATA_SIZE
      )
        throw new Error("The simulated order has a different number of levels.");
      const actual = Array.from({ length: count }, (_, i) => {
        const at = header + i * sdk.LIMIT_ORDER_BIN_DATA_SIZE;
        return {
          binId: data.readInt32LE(at + 16),
          amount: data.readBigUInt64LE(at).toString(),
          isAsk: data[at + 20],
        };
      });
      for (const level of ladder.bins) {
        const v = actual.find((a) => a.binId === level.binId);
        if (!v || v.amount !== level.amountRaw || v.isAsk !== (o.action === "sell" ? 1 : 0))
          throw new Error("The simulated order differs from the reviewed levels, amounts or side.");
      }
    }
    simulatedAccountVerified = true;
  });
  const temporaryRentLamports = funding.reduce((n, f) => n + f.temporaryRentLamports, 0);
  const wrapped = funding.reduce((n, f) => n + f.wrappedLamports, 0n);
  if (costs.requiredLamports !== null && costs.feeLamports !== null) {
    // A closed temporary ATA's rent is absent from post-state; retain it as upfront funding.
    const required = Math.max(
      costs.requiredLamports + temporaryRentLamports,
      Number(wrapped) + temporaryRentLamports + costs.feeLamports,
    );
    costs.requiredLamports = Number.isSafeInteger(required) && required >= 0 ? required : null;
  }
  o.job.check();
  return {
    blueprint,
    digest,
    action: o.action,
    snapshot,
    compiled,
    tx,
    signers,
    account: account.toBase58(),
    newPosition,
    costs,
    refusal:
      foundryCostRefusal(costs, blueprint.rules.maxNetworkFeeLamports) ??
      (!simulatedAccountVerified ? "The simulated target account could not be verified." : null),
    nativeWeights,
    temporaryRentLamports,
    wrappedLamports: wrapped.toString(),
    simulatedAccountVerified,
  };
}
/** Recheck mutable protocol facts before and after wallet approval; stale messages never send. */
export async function revalidateFoundryAction(
  connection: Connection,
  built: FoundryBuild,
  owner: PublicKey,
  job: Job,
): Promise<string | null> {
  const { snapshot, pool, sdk } = await readFoundryPool(connection, built.blueprint.pool, job);
  const why = validateFoundryPool(snapshot, built.blueprint, built.action);
  if (why) return why;
  if (
    snapshot.tokenProgramX !== built.snapshot.tokenProgramX ||
    snapshot.tokenProgramY !== built.snapshot.tokenProgramY ||
    snapshot.decimalsX !== built.snapshot.decimalsX ||
    snapshot.decimalsY !== built.snapshot.decimalsY ||
    snapshot.feeCurrency !== built.snapshot.feeCurrency ||
    snapshot.functionType !== built.snapshot.functionType
  )
    return "The verified mint or protocol configuration changed. Prepare again.";
  if (
    Math.abs(snapshot.activeBinId - built.snapshot.activeBinId) >
    built.blueprint.rules.maxActiveBinDrift
  )
    return "The active bin moved beyond this blueprint's review tolerance.";
  if (built.action !== "liquidity") {
    const ladder = built.compiled.ladders.find((l) => l.side === built.action)!;
    if (
      ladder.bins.some((b) =>
        built.action === "buy" ? b.binId >= snapshot.activeBinId : b.binId <= snapshot.activeBinId,
      )
    )
      return "An order level crossed the active bin. Prepare a fresh ladder.";
  } else if (!built.newPosition) {
    const { PublicKey } = await import("@solana/web3.js");
    job.check();
    const info = await job.step(
      connection.getAccountInfo(new PublicKey(built.account), "confirmed"),
      T,
      "Position recheck",
    );
    if (
      !verifyDlmmAccount(info, {
        programId: DLMM_PROGRAM,
        discriminator: new Uint8Array(sdk.getAccountDiscriminator("positionV2")),
        lbPair: pool.pubkey.toBytes(),
        owner: owner.toBytes(),
      })
    )
      return "Position identity changed.";
    const position = pool.program.coder.accounts.decode("positionV2", info!.data) as {
      lowerBinId: number;
      upperBinId: number;
    };
    if (
      position.lowerBinId !== built.compiled.lowerBinId ||
      position.upperBinId !== built.compiled.upperBinId
    )
      return "The position's bounds changed. Prepare again.";
  }
  return null;
}

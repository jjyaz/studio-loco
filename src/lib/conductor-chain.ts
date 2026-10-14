/** Isolated read-only DLMM instance. Never shares mutable state with wallet builders. */
import BN from "bn.js";
import { Buffer } from "buffer";
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import type { BinArrayAccount, BinArrayBitmapExtensionAccount, LbPair } from "@meteora-ag/dlmm";
import { loadSdk, DLMM_PROGRAM_ID } from "./dlmm";
import { assertCluster } from "./tx";
import { JobCancelled, JobTimeout, type Job } from "./job-control";
import { readJourneySnapshot } from "./journey-chain";
import { listJourneys } from "./journey-store";
import { redact } from "./recorder";
import {
  CONDUCTOR_ADAPTER,
  MissionRaw,
  MissionSnapshot,
  type MissionQuote,
  type MissionScope,
} from "../../packages/sdk/src/conductor";
const STEP = 12_000;
const errorText = (e: unknown) =>
  redact(e instanceof Error ? e.message : "Read unavailable").slice(0, 300);

export async function readConductorSnapshot(
  connection: Connection,
  input: {
    pool: string;
    owner: string;
    probesX: string[];
    probesY: string[];
    position?: { account: string; journeyId: string } | null;
    expectedScope?: MissionScope;
    minimumSlot?: number;
  },
  caller: Job,
  rpcKind: "relay" | "custom" | "server",
): Promise<MissionSnapshot> {
  const startedAt = Date.now(),
    deadline = startedAt + 90_000;
  const job: Job = {
    ...caller,
    check() {
      caller.check();
      if (Date.now() >= deadline) throw new Error("Conductor read exceeded its overall deadline.");
    },
    step(p, ms, label) {
      this.check();
      return caller.step(p, Math.max(1, Math.min(ms, deadline - Date.now())), label);
    },
  };
  if (input.probesX.length > 3 || input.probesY.length > 3)
    throw new Error("At most three independent probes per direction.");
  [...input.probesX, ...input.probesY].forEach((n) => {
    MissionRaw.parse(n);
    if (BigInt(n) === 0n) throw new Error("Probe amounts must be positive.");
  });
  const { PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram } = await import("@solana/web3.js");
  const spl = await import("@solana/spl-token");
  job.check();
  const key = new PublicKey(input.pool),
    owner = new PublicKey(input.owner);
  await job.step(assertCluster(connection, "mainnet-beta"), STEP, "Mainnet genesis");
  const sdk = await job.step(loadSdk(), STEP, "DLMM adapter");
  const program = new PublicKey(DLMM_PROGRAM_ID);
  function verify(
    info: AccountInfo<Buffer> | null | undefined,
    name: "lbPair" | "binArray" | "binArrayBitmapExtension",
  ) {
    const disc = new Uint8Array(sdk.getAccountDiscriminator(name));
    if (
      !info ||
      info.executable ||
      !info.owner.equals(program) ||
      disc.length !== 8 ||
      !disc.every((n, i) => info.data[i] === n)
    )
      throw new Error(`Unverified ${name} account.`);
    return info;
  }
  const initial = await job.step(
    connection.getAccountInfoAndContext(key, {
      commitment: "confirmed",
      minContextSlot: input.minimumSlot ?? 0,
    }),
    STEP,
    "Pool identity",
  );
  verify(initial.value, "lbPair");
  const pool = await job.step(
    sdk.default.create(connection, key, {
      cluster: "mainnet-beta",
      skipSolWrappingOperation: true,
    }),
    STEP,
    "Isolated pool state",
  );
  if (!pool.pubkey.equals(key) || !pool.program.programId.equals(program))
    throw new Error("SDK pool/program identity differs.");
  const bitmapKey = sdk.deriveBinArrayBitmapExtension(key, program)[0];
  function discover(pair: LbPair, bitmap: BinArrayBitmapExtensionAccount | null) {
    const addresses = new Map<string, PublicKey>();
    for (const swapForY of [true, false]) {
      let active = pair.activeId;
      for (let i = 0; i < 2; i++) {
        const index = sdk.findNextBinArrayIndexWithLiquidity(
          swapForY,
          new BN(active),
          pair,
          bitmap?.account ?? null,
        );
        if (index === null) break;
        const address = sdk.deriveBinArray(key, index, program)[0];
        addresses.set(address.toBase58(), address);
        const [lower, upper] = sdk.getBinArrayLowerUpperBinId(index);
        active = swapForY ? lower!.toNumber() - 1 : upper!.toNumber() + 1;
      }
    }
    return [...addresses.values()];
  }
  const discovered = discover(pool.lbPair, pool.binArrayBitmapExtension);
  // <=9 keys: the relay never has to split this logical quote snapshot into different contexts.
  const keys = [
    key,
    pool.lbPair.tokenXMint,
    pool.lbPair.tokenYMint,
    SYSVAR_CLOCK_PUBKEY,
    bitmapKey,
    ...discovered,
  ];
  if (keys.length > 9) throw new Error("Quote snapshot exceeds its verified coverage bound.");
  const read = await job.step(
    connection.getMultipleAccountsInfoAndContext(keys, {
      commitment: "confirmed",
      minContextSlot: Math.max(input.minimumSlot ?? 0, initial.context.slot),
    }),
    STEP,
    "Pool, mints, clock and bin snapshot",
  );
  if (
    read.context.slot < Math.max(input.minimumSlot ?? 0, initial.context.slot) ||
    read.value.length !== keys.length
  )
    throw new Error("RPC snapshot context moved backwards or omitted accounts.");
  const pair = pool.program.coder.accounts.decode(
    "lbPair",
    verify(read.value[0], "lbPair").data,
  ) as LbPair;
  if (
    !pair.tokenXMint.equals(keys[1]!) ||
    !pair.tokenYMint.equals(keys[2]!) ||
    pair.tokenXMint.equals(pair.tokenYMint)
  )
    throw new Error("Pool mints changed while reading.");
  const mints = [pair.tokenXMint, pair.tokenYMint].map((mint, i) => {
    const info = read.value[i + 1];
    // Transfer fees/hooks require a separately validated adapter; never treat them as zero.
    if (!info || info.executable || !info.owner.equals(spl.TOKEN_PROGRAM_ID))
      throw new Error(
        "Conductor v1 quotes support standard SPL Token mints. Token-2022 transfer effects are not modeled.",
      );
    const decoded = spl.unpackMint(mint, info, spl.TOKEN_PROGRAM_ID);
    if (!decoded.isInitialized || decoded.decimals > 18)
      throw new Error("Unsupported mint initialization or precision.");
    return decoded;
  });
  let bitmap: BinArrayBitmapExtensionAccount | null = null;
  if (read.value[4]) {
    const account = pool.program.coder.accounts.decode(
      "binArrayBitmapExtension",
      verify(read.value[4], "binArrayBitmapExtension").data,
    );
    if (!account.lbPair.equals(key)) throw new Error("Bitmap belongs to a different pool.");
    bitmap = { publicKey: bitmapKey, account };
  }
  const arrays: BinArrayAccount[] = discovered.map((publicKey, i) => {
    const account = pool.program.coder.accounts.decode(
      "binArray",
      verify(read.value[i + 5], "binArray").data,
    );
    if (
      !account.lbPair.equals(key) ||
      !sdk.deriveBinArray(key, account.index, program)[0].equals(publicKey)
    )
      throw new Error("Bin array address or pool binding differs.");
    return { publicKey, account };
  });
  const needed = discover(pair, bitmap);
  if (needed.some((k) => !arrays.some((a) => a.publicKey.equals(k))))
    throw new Error(
      "The active liquidity changed during discovery. Refresh for a new bounded snapshot.",
    );
  const clockInfo = read.value[3];
  if (
    !clockInfo ||
    clockInfo.executable ||
    clockInfo.data.length < 40 ||
    clockInfo.owner.toBase58() !== "Sysvar1111111111111111111111111111111111111"
  )
    throw new Error("Solana clock could not be verified.");
  const c = sdk.ClockLayout.decode(clockInfo.data);
  pool.clock = {
    slot: new BN(c.slot),
    epochStartTimestamp: new BN(c.epochStartTimestamp),
    epoch: new BN(c.epoch),
    leaderScheduleEpoch: new BN(c.leaderScheduleEpoch),
    unixTimestamp: new BN(c.unixTimestamp),
  };
  const chainTime = pool.clock.unixTimestamp.toNumber() * 1000;
  if (!Number.isSafeInteger(chainTime) || Math.abs(Date.now() - chainTime) > 60_000)
    throw new Error(
      "Device and Solana clocks differ by over 60 seconds; dynamic-fee quotes are unavailable.",
    );
  pool.lbPair = pair;
  pool.binArrayBitmapExtension = bitmap;
  pool.tokenX = {
    ...pool.tokenX,
    publicKey: pair.tokenXMint,
    reserve: pair.reserveX,
    mint: mints[0]!,
    owner: spl.TOKEN_PROGRAM_ID,
  };
  pool.tokenY = {
    ...pool.tokenY,
    publicKey: pair.tokenYMint,
    reserve: pair.reserveY,
    mint: mints[1]!,
    owner: spl.TOKEN_PROGRAM_ID,
  };
  if (![0, 1].includes(pair.activationType) || ![0, 1].includes(pair.parameters.collectFeeMode))
    throw new Error("Unrecognized activation or fee mode.");
  const enabled = pair.status === 0;
  const activated = pair.activationPoint.lte(
    pair.activationType === 0 ? pool.clock.slot : pool.clock.unixTimestamp,
  );
  const scope: MissionScope = {
    pool: key.toBase58(),
    owner: owner.toBase58(),
    mintX: pair.tokenXMint.toBase58(),
    mintY: pair.tokenYMint.toBase58(),
    decimalsX: mints[0]!.decimals,
    decimalsY: mints[1]!.decimals,
    binStep: pair.binStep,
    position: input.position?.account ?? null,
    journeyId: input.position?.journeyId ?? null,
  };
  if (input.expectedScope && JSON.stringify(scope) !== JSON.stringify(input.expectedScope))
    throw new Error("Fresh scope differs from the sealed mission.");
  const quotes: MissionQuote[] = [];
  for (const direction of ["x-to-y", "y-to-x"] as const) {
    for (const inputRaw of direction === "x-to-y" ? input.probesX : input.probesY) {
      job.check();
      if (!enabled || !activated) {
        quotes.push({
          status: "unavailable",
          direction,
          inputRaw,
          reason: "Pool is disabled or has not activated.",
        });
        continue;
      }
      try {
        // SDK clones volatility state; bins are never consumed or mutated by these independent quotes.
        const quote = pool.swapQuote(
          new BN(inputRaw),
          direction === "x-to-y",
          new BN(0),
          arrays,
          false,
          0,
        );
        const binArrays = quote.binArraysPubkey.map((k: PublicKey) => k.toBase58());
        if (
          !quote.consumedInAmount.eq(new BN(inputRaw)) ||
          quote.outAmount.lte(new BN(0)) ||
          binArrays.some((k: string) => !arrays.some((a) => a.publicKey.toBase58() === k))
        )
          throw new Error(
            "A complete positive-output quote was not obtained within loaded coverage.",
          );
        quotes.push({
          status: "quoted",
          direction,
          inputRaw,
          consumedRaw: quote.consumedInAmount.toString(),
          outputRaw: quote.outAmount.toString(),
          lpFeeRaw: quote.fee.toString(),
          protocolFeeRaw: quote.protocolFee.toString(),
          feeOnInput: quote.feeOnInput,
          binArrays,
        });
      } catch {
        quotes.push({
          status: "unavailable",
          direction,
          inputRaw,
          reason:
            "No full quote within two loaded bin arrays per direction. This does not establish zero liquidity or the pool's maximum capacity.",
        });
      }
    }
  }
  let funds: MissionSnapshot["funds"] = null,
    fundsError: string | null = null;
  try {
    const atas = [pair.tokenXMint, pair.tokenYMint].map((mint) =>
      spl.getAssociatedTokenAddressSync(mint, owner, true, spl.TOKEN_PROGRAM_ID),
    );
    const balances = await job.step(
      connection.getMultipleAccountsInfoAndContext([owner, ...atas], {
        commitment: "confirmed",
        minContextSlot: read.context.slot,
      }),
      STEP,
      "Owner SOL and associated-token balances",
    );
    if (balances.context.slot < read.context.slot || balances.value.length !== 3)
      throw new Error("Owner balance context is incomplete or older than the pool snapshot.");
    const sol = balances.value[0]?.lamports ?? 0;
    const solAccount = balances.value[0];
    if (
      solAccount &&
      (solAccount.executable ||
        !solAccount.owner.equals(SystemProgram.programId) ||
        solAccount.data.length !== 0)
    )
      throw new Error(
        "The observed address is not a standard SOL funding account; an operating reserve is unavailable.",
      );
    if (!Number.isSafeInteger(sol) || sol < 0)
      throw new Error("SOL balance exceeds exact RPC integer precision.");
    const amounts = atas.map((ata, i) => {
      const info = balances.value[i + 1];
      if (!info) return "0"; // confirmed absence at the canonical ATA is a known zero for that account only
      if (info.executable) throw new Error("Associated token account is unexpectedly executable.");
      const a = spl.unpackAccount(ata, info, spl.TOKEN_PROGRAM_ID);
      if (
        !a.owner.equals(owner) ||
        !a.mint.equals(i === 0 ? pair.tokenXMint : pair.tokenYMint) ||
        !a.isInitialized ||
        a.isFrozen
      )
        throw new Error("Associated-token identity or spendability could not be verified.");
      return a.amount.toString();
    });
    funds = {
      slot: balances.context.slot,
      observedAt: Date.now(),
      solLamports: String(sol),
      ataXRaw: amounts[0]!,
      ataYRaw: amounts[1]!,
    };
  } catch (e) {
    if (e instanceof JobCancelled || e instanceof JobTimeout || !job.alive()) throw e;
    fundsError = errorText(e);
  }
  let position: MissionSnapshot["position"] = null,
    positionError: string | null = null;
  if (input.position) {
    try {
      const assertSource = async () => {
        const j = (await job.step(listJourneys(), 4000, "Source Journey")).find(
          (j) => j.id === input.position!.journeyId,
        );
        if (
          !j ||
          j.kind !== "position" ||
          j.account !== input.position!.account ||
          j.pool !== scope.pool ||
          j.owner !== scope.owner
        )
          throw new Error("The source Journey was removed or its identity differs.");
        return j;
      };
      const j = await assertSource();
      const s = await readJourneySnapshot(
        connection,
        { kind: "position", account: j.account, pool: j.pool, owner: j.owner },
        job,
        rpcKind,
        j.snapshots.at(-1),
        Math.max(read.context.slot, funds?.slot ?? 0),
        Math.min(40_000, deadline - Date.now()),
      );
      await assertSource();
      if (
        s.kind !== "position" ||
        s.mintX !== scope.mintX ||
        s.mintY !== scope.mintY ||
        s.decX !== scope.decimalsX ||
        s.decY !== scope.decimalsY
      )
        throw new Error("Position inventory scope differs from the quote snapshot.");
      position = {
        account: j.account,
        slot: s.checkedSlot,
        observedAt: s.observedAt,
        holdingsXRaw: s.holdingsX,
        holdingsYRaw: s.holdingsY,
        feeXRaw: s.feeX,
        feeYRaw: s.feeY,
        lower: s.lower,
        upper: s.upper,
      };
    } catch (e) {
      if (e instanceof JobCancelled || e instanceof JobTimeout || !job.alive()) throw e;
      positionError = errorText(e);
    }
  }
  job.check();
  return MissionSnapshot.parse({
    scope,
    adapter: CONDUCTOR_ADAPTER,
    startedAt,
    observedAt: Date.now(),
    slot: read.context.slot,
    chainTime,
    rpcKind,
    activeId: pair.activeId,
    enabled,
    activated,
    referencePriceQ64: sdk.getQPriceFromId(new BN(pair.activeId), new BN(pair.binStep)).toString(),
    binArrays: arrays.map((a) => a.publicKey.toBase58()),
    arraysPerDirection: 2,
    quotes,
    funds,
    fundsError,
    position,
    positionError,
  });
}

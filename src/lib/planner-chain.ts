/**
 * Rebalance Planner chain reads. READ-ONLY: uses the SDK's own rebalance amount simulation
 * and unsigned exact transaction simulations. Never signs or sends a transaction.
 * Every selection is rebuilt again for a fresh wallet review.
 */
import type { Connection } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import type { Job } from "./job-control";
import { type StrategyName } from "./strategy";
import { pairOrientation } from "./agents";
import { JobCancelled, JobTimeout } from "./job-control";
import { buildNativeRebalance, buildWithdraw, type CostReview } from "./agents-chain";
import {
  covers,
  mapToDestination,
  sdkSolToLamports,
  targetFor,
  validateWiden,
  type OptionResult,
  type PlanOption,
  type Range,
} from "./planner";

const T = 15_000;

export interface PlanRead {
  activeId: number;
  slot: number | null;
  current: Range;
  mintX: string;
  mintY: string;
  decX: number;
  decY: number;
  results: OptionResult[];
}

export async function readPlan(o: {
  connection: Connection;
  cluster: "mainnet-beta" | "devnet";
  owner: string;
  pool: string;
  position: string;
  strategy: StrategyName;
  slippageBps: number;
  widen: Range | null;
  destPool: string | null;
  job: Job;
}): Promise<PlanRead> {
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await o.job.step(loadSdk(), T, "SDK load");
  const pool = await o.job.step(
    sdk.default.create(o.connection, new PublicKey(o.pool), {
      cluster: o.cluster,
      skipSolWrappingOperation: true,
    }),
    T,
    "Pool read",
  );
  const posKey = new PublicKey(o.position);
  const pos = await o.job.step(pool.getPosition(posKey), T, "Position read");
  const pd = pos.positionData;
  if (!pd.owner.equals(new PublicKey(o.owner)))
    throw new Error("Position owner does not match the address being planned for.");
  // Observed slot is a timestamp aid, not a claim that multiple SDK reads share one bank.
  const slot = await o.job.step(o.connection.getSlot("confirmed"), T, "Observed slot");
  const activeId = pool.lbPair.activeId;
  const current = { lower: pd.lowerBinId, upper: pd.upperBinId };
  const mintX = pool.tokenX.publicKey.toBase58(),
    mintY = pool.tokenY.publicKey.toBase58();
  const decX = pool.tokenX.mint.decimals,
    decY = pool.tokenY.mint.decimals;
  const results: OptionResult[] = [
    {
      option: "keep",
      target: null,
      sim: "none",
      rentLamports: 0n,
      coversActive: covers(current, activeId),
    },
  ];

  const simulate = async (option: PlanOption, target: Range): Promise<OptionResult> => {
    try {
      const built = await buildNativeRebalance({
        connection: o.connection,
        owner: new PublicKey(o.owner),
        poolAddress: o.pool,
        position: o.position,
        strategy: o.strategy,
        slippageBps: o.slippageBps,
        cluster: o.cluster,
        job: o.job,
        target,
      });
      if (!built.ok)
        return { option, target, sim: "unsupported", rentLamports: null, reason: built.reason };
      const b = built.built;
      if (b.activeId !== activeId)
        throw new Error("The active bin moved during comparison. Re-run from fresh state.");
      const bin = sdkSolToLamports(b.binArrayCost),
        bmp = sdkSolToLamports(b.bitmapExtensionCost);
      const resize = b.positionRentLamports === undefined ? null : BigInt(b.positionRentLamports);
      const c = summaryCosts(b.costs);
      const simOk = c.simError === null && c.units !== null && c.units > 0;
      return {
        option,
        target,
        sim: simOk ? "sdk-ok" : "failed",
        coversActive: covers(target, activeId),
        activeId,
        withdrawX: b.withdrawn.x,
        withdrawY: b.withdrawn.y,
        depositX: b.deposited.x,
        depositY: b.deposited.y,
        walletOutX: b.walletOut.x,
        walletOutY: b.walletOut.y,
        topUpX: "0",
        topUpY: "0",
        rentLamports:
          bin === null || bmp === null || resize === null
            ? null
            : bin + bmp + (resize > 0n ? resize : 0n),
        costs: c,
        reason: !simOk
          ? (c.simError ?? "Exact simulation results unavailable.")
          : b.kind === "split"
            ? "Only account creation was simulated. Native rebalance needs a separate fresh review after confirmation; later fee and SOL requirements remain unpriced."
            : "Unsigned exact transaction simulation passed. Costs are a snapshot and will be rebuilt before approval.",
      };
    } catch (e) {
      if (e instanceof JobCancelled || e instanceof JobTimeout) throw e;
      return {
        option,
        target,
        sim: "failed",
        rentLamports: null,
        reason: `SDK simulation failed: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}`,
      };
    }
  };

  results.push(await simulate("recenter", targetFor("recenter", current, activeId)!));
  if (o.widen && validateWiden(current, o.widen.lower, o.widen.upper).ok)
    results.push(await simulate("widen", o.widen));
  else
    results.push({
      option: "widen",
      target: null,
      sim: "unsupported",
      rentLamports: null,
      reason: "Choose an explicit wider range to compare.",
    });

  if (o.destPool && o.destPool !== o.pool) {
    try {
      const dest = await o.job.step(
        sdk.default.create(o.connection, new PublicKey(o.destPool), {
          cluster: o.cluster,
          skipSolWrappingOperation: true,
        }),
        T,
        "Destination pool read",
      );
      const dX = dest.tokenX.publicKey.toBase58(),
        dY = dest.tokenY.publicKey.toBase58();
      if (!pairOrientation(dX, dY, mintX, mintY))
        throw new Error("Destination does not hold the same two mint addresses.");
      const withdrawal = await buildWithdraw({
        connection: o.connection,
        owner: new PublicKey(o.owner),
        poolAddress: o.pool,
        position: o.position,
        bps: 10000,
        cluster: o.cluster,
        label: "Planner staged withdrawal",
        job: o.job,
      });
      const costs = summaryCosts(withdrawal.costs);
      const m = mapToDestination(
        { mintX, mintY, x: withdrawal.estX, y: withdrawal.estY },
        { mintX: dX, mintY: dY },
      );
      const target = targetFor("move", current, activeId, undefined, dest.lbPair.activeId)!;
      results.push({
        option: "move",
        target,
        sim:
          costs.simError === null && costs.units !== null && costs.units > 0
            ? "staged-verified"
            : "failed",
        destPool: o.destPool,
        orientation: m.orientation,
        coversActive: true,
        activeId: dest.lbPair.activeId,
        costs: { ...costs, remaining: 1 },
        withdrawX: withdrawal.estX,
        withdrawY: withdrawal.estY,
        depositX: m.x,
        depositY: m.y,
        rentLamports: null,
        reason:
          "Stage 1 is a simulated 100% withdrawal, leaving fees and rewards in the open position. Amounts are estimates with no enforced withdrawal floor. Stage 2 needs a separate fresh deposit and approval using actual balances; destination costs remain unpriced.",
      });
    } catch (e) {
      if (e instanceof JobCancelled || e instanceof JobTimeout) throw e;
      results.push({
        option: "move",
        target: null,
        sim: "failed",
        rentLamports: null,
        destPool: o.destPool,
        reason: e instanceof Error ? e.message.slice(0, 200) : "Destination unavailable",
      });
    }
  } else
    results.push({
      option: "move",
      target: null,
      sim: "unsupported",
      rentLamports: null,
      reason: "Pick a verified same-pair pool to compare a move.",
    });

  return { activeId, slot, current, mintX, mintY, decX, decY, results };
}

function summaryCosts(c: CostReview): NonNullable<OptionResult["costs"]> {
  return {
    feeLamports: c.feeLamports,
    solOutLamports: c.solOutLamports,
    requiredLamports: c.requiredLamports,
    walletLamports: c.walletLamports,
    simError: c.simErrors[0] ?? null,
    units: c.units[0] ?? null,
    size: Number.isFinite(c.sizes[0]) ? c.sizes[0]! : null,
    remaining: c.remaining,
  };
}

/**
 * Rebalance Planner chain reads. READ-ONLY: uses the SDK's own rebalance amount simulation
 * (simulateRebalancePosition) and never builds, signs or sends a transaction.
 * Network fees and exact transaction simulation happen only in the fresh review.
 */
import BN from "bn.js";
import type { Connection } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import type { Job } from "./job-control";
import { STRATEGY_TYPE_VALUE, type StrategyName } from "./strategy";
import { pairOrientation } from "./agents";
import { covers, mapToDestination, sdkSolToLamports, targetFor, type OptionResult, type PlanOption, type Range } from "./planner";

const T = 15_000;

export interface PlanRead {
  activeId: number; slot: number | null; current: Range;
  mintX: string; mintY: string; decX: number; decY: number;
  results: OptionResult[];
}

export async function readPlan(o: {
  connection: Connection; cluster: "mainnet-beta" | "devnet"; owner: string; pool: string; position: string;
  strategy: StrategyName; widen: Range | null; destPool: string | null; job: Job;
}): Promise<PlanRead> {
  const { PublicKey } = await import("@solana/web3.js");
  const sdk = await o.job.step(loadSdk(), T, "SDK load");
  const pool = await o.job.step(sdk.default.create(o.connection, new PublicKey(o.pool), { cluster: o.cluster, skipSolWrappingOperation: true }), T, "Pool read");
  const posKey = new PublicKey(o.position);
  const pos = await o.job.step(pool.getPosition(posKey), T, "Position read");
  const pd = pos.positionData;
  if (!pd.owner.equals(new PublicKey(o.owner))) throw new Error("Position owner does not match the address being planned for.");
  const slot = await o.job.step(o.connection.getSlot("confirmed"), T, "Snapshot slot").catch(() => null);
  const activeId = pool.lbPair.activeId;
  const current = { lower: pd.lowerBinId, upper: pd.upperBinId };
  const mintX = pool.tokenX.publicKey.toBase58(), mintY = pool.tokenY.publicKey.toBase58();
  const decX = pool.tokenX.mint.decimals, decY = pool.tokenY.mint.decimals;
  const availX = new BN(pd.totalXAmount.split(".")[0] ?? "0").add(pd.feeX);
  const availY = new BN(pd.totalYAmount.split(".")[0] ?? "0").add(pd.feeY);
  const results: OptionResult[] = [{ option: "keep", target: null, sim: "none", rentLamports: 0n, coversActive: covers(current, activeId) }];

  const simulate = async (option: PlanOption, target: Range): Promise<OptionResult> => {
    try {
      const minDeltaId = new BN(target.lower - activeId), maxDeltaId = new BN(target.upper - activeId);
      const params = sdk.buildLiquidityStrategyParameters(availX, availY, minDeltaId, maxDeltaId, new BN(pool.lbPair.binStep), false, new BN(activeId), sdk.getLiquidityStrategyParameterBuilder(STRATEGY_TYPE_VALUE[o.strategy] as never));
      const resp = await o.job.step(pool.simulateRebalancePosition(posKey, pd, true, true,
        [{ minDeltaId, maxDeltaId, x0: params.x0, y0: params.y0, deltaX: params.deltaX, deltaY: params.deltaY, favorXInActiveBin: false }],
        [{ minBinId: new BN(pd.lowerBinId), maxBinId: new BN(pd.upperBinId), bps: new BN(10_000) }]), T, `${option} simulation`);
      const s = resp.simulationResult;
      const bin = sdkSolToLamports(resp.binArrayCost), bmp = sdkSolToLamports(resp.bitmapExtensionCost);
      return {
        option, target, sim: "sdk-ok", coversActive: covers(target, activeId),
        withdrawX: s.amountXDeposited.add(s.actualAmountXWithdrawn).toString(), withdrawY: s.amountYDeposited.add(s.actualAmountYWithdrawn).toString(),
        depositX: s.amountXDeposited.toString(), depositY: s.amountYDeposited.toString(),
        walletOutX: s.actualAmountXWithdrawn.toString(), walletOutY: s.actualAmountYWithdrawn.toString(),
        topUpX: s.actualAmountXDeposited.toString(), topUpY: s.actualAmountYDeposited.toString(),
        // Position resize rent is not quoted by the SDK simulation: stays unpriced until the fresh review.
        rentLamports: bin === null || bmp === null || target.upper - target.lower !== current.upper - current.lower ? null : bin + bmp,
        ...(target.upper - target.lower !== current.upper - current.lower ? { reason: "Wider range: position-resize rent is unpriced until the fresh review." } : {}),
      };
    } catch (e) {
      return { option, target, sim: "failed", rentLamports: null, reason: `SDK simulation failed: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}` };
    }
  };

  results.push(await simulate("recenter", targetFor("recenter", current, activeId)!));
  if (o.widen) results.push(await simulate("widen", o.widen));
  else results.push({ option: "widen", target: null, sim: "unsupported", rentLamports: null, reason: "Choose an explicit wider range to compare." });

  if (o.destPool && o.destPool !== o.pool) {
    try {
      const dest = await o.job.step(sdk.default.create(o.connection, new PublicKey(o.destPool), { cluster: o.cluster, skipSolWrappingOperation: true }), T, "Destination pool read");
      const dX = dest.tokenX.publicKey.toBase58(), dY = dest.tokenY.publicKey.toBase58();
      if (!pairOrientation(dX, dY, mintX, mintY)) throw new Error("Destination does not hold the same two mint addresses.");
      const m = mapToDestination({ mintX, mintY, x: availX.toString(), y: availY.toString() }, { mintX: dX, mintY: dY });
      const target = targetFor("move", current, activeId, undefined, dest.lbPair.activeId)!;
      results.push({
        option: "move", target, sim: "staged-verified", destPool: o.destPool, orientation: m.orientation, coversActive: true,
        withdrawX: availX.toString(), withdrawY: availY.toString(), depositX: m.x, depositY: m.y, rentLamports: null,
        reason: "Two separate approvals: stage 1 withdraws 100% here; stage 2 is a fresh deposit built from what actually arrives. Destination amounts are the position's current holdings mapped by mint address, not a simulated deposit.",
      });
    } catch (e) {
      results.push({ option: "move", target: null, sim: "failed", rentLamports: null, destPool: o.destPool, reason: e instanceof Error ? e.message.slice(0, 200) : "Destination unavailable" });
    }
  } else results.push({ option: "move", target: null, sim: "unsupported", rentLamports: null, reason: "Pick a verified same-pair pool to compare a move." });

  return { activeId, slot, current, mintX, mintY, decX, decY, results };
}

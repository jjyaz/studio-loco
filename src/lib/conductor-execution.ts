/** Wallet-approved mission actions. Hosted/imported history is never permission. */
import BN from "bn.js";
import { Buffer } from "buffer";
import type { Idl } from "@coral-xyz/anchor";
import type { Connection, Transaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { loadSdk } from "./dlmm";
import { JobControl, type Job } from "./job-control";
import { readConductorSnapshot } from "./conductor-chain";
import { buildNativeRebalance, buildWithdraw, reviewCosts, type CostReview } from "./agents-chain";
import {
  MissionPolicyRevision,
  missionPolicyDigest,
  type ConductorMission,
  type MissionSnapshot,
} from "./conductor";
import {
  Operation,
  type ExecutionBudget,
  type OperationState,
} from "../../packages/sdk/src/ledger";
import {
  readExecutionState,
  proposeOperation,
  transitionOperation,
  type OperationRow,
} from "./ledger-store";
import { assertCluster, checkSignature, withTimeout, type TxContext } from "./tx";
import { newId, redact } from "./recorder";
import { recordFact, getRecord, usingMemoryFallback } from "./recorder-store";
import {
  executionHash,
  instructionHash,
  inspectMissionInstructions,
  verifiedOperationSpend,
  type ExecutionBinding,
} from "./conductor-execution-proof";
import type { InstructionSpec } from "./continuity-proof";

export type MissionActionInput = {
  action: "claim" | "withdraw" | "rebalance";
  bps: number;
  strategy: "Spot" | "Curve" | "BidAsk";
  slippageBps: number;
};
export interface BuiltMissionAction {
  missionId: string;
  digest: string;
  budgetRevision: number;
  action: MissionActionInput["action"];
  tx: Transaction;
  label: string;
  snapshot: MissionSnapshot;
  costs: CostReview;
  binding: ExecutionBinding;
  instructionHash: string;
  instructionNames: string[];
  preparedAt: number;
  expiresAt: number;
  inspect(tx: Transaction): void;
  verifySource(connection: Connection, job: Job): Promise<void>;
}
const specsOf = (idl: { instructions: readonly ({ name: string } & InstructionSpec)[] }) =>
  Object.fromEntries(idl.instructions.map((i) => [i.name, i]));
const safe = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
function costCheck(c: CostReview) {
  if (
    c.remaining ||
    c.simErrors.some(Boolean) ||
    !safe(c.feeLamports) ||
    !safe(c.requiredLamports) ||
    !safe(c.walletLamports)
  )
    throw new Error(
      "Complete successful single-transaction simulation, fee, rent and funding evidence is required.",
    );
}
function assertBudget(mission: ConductorMission, budget: ExecutionBudget | undefined) {
  const p = mission.policies.at(-1)!;
  if (
    !budget ||
    budget.policyDigest !== p.digest ||
    Date.now() >= budget.expiresAt ||
    Date.now() >= p.policy.expiresAt
  )
    throw new Error("Seal a current cumulative execution budget for this policy first.");
  return budget;
}

export async function buildMissionAction(
  connection: Connection,
  missionId: string,
  input: MissionActionInput,
  job: Job,
  rpcKind: "relay" | "custom",
) {
  const local = await job.step(readExecutionState(missionId), 4000, "Local execution state");
  const policy = local.mission.policies.at(-1)!;
  const budget = assertBudget(local.mission, local.budgets.at(-1)?.budget),
    s = policy.policy.scope;
  if (!s.position || !s.journeyId)
    throw new Error("Attach a retained Journey LP position to use mission execution.");
  if (
    !policy.policy.allowedActions.includes(input.action) ||
    !budget.allowedActions.includes(input.action)
  )
    throw new Error("The sealed policy/budget does not allow this action.");
  const snapshot = await readConductorSnapshot(
    connection,
    {
      pool: s.pool,
      owner: s.owner,
      probesX: policy.policy.probesX,
      probesY: policy.policy.probesY,
      position: { account: s.position, journeyId: s.journeyId },
      expectedScope: s,
      minimumSlot: local.mission.samples.at(-1)?.snapshot.slot,
    },
    job,
    rpcKind,
  );
  if (!snapshot.position)
    throw new Error(
      snapshot.positionError ?? "Fresh independently verified LP inventory is required.",
    );
  const owner = new PublicKey(s.owner),
    sdk = await job.step(loadSdk(), 12_000, "Execution SDK");
  const pool = await job.step(
    sdk.default.create(connection, new PublicKey(s.pool), {
      cluster: "mainnet-beta",
      skipSolWrappingOperation: true,
    }),
    12_000,
    "Execution pool",
  );
  if (
    pool.lbPair.tokenXMint.toBase58() !== s.mintX ||
    pool.lbPair.tokenYMint.toBase58() !== s.mintY ||
    pool.lbPair.binStep !== s.binStep
  )
    throw new Error("Execution pool identity changed.");
  let tx: Transaction,
    target: ExecutionBinding["target"] = null,
    maxActiveBinSlippage = 0,
    executionActiveId = snapshot.activeId;
  const source = { lower: snapshot.position.lower, upper: snapshot.position.upper };
  if (input.action === "rebalance") {
    if (pool.lbPair.rewardInfos.some((r) => !r.mint.equals(PublicKey.default)))
      throw new Error(
        "Reward-harvesting rebalances are outside this verified adapter; use the separate Planner review.",
      );
    const b = await buildNativeRebalance({
      connection,
      owner,
      poolAddress: s.pool,
      position: s.position,
      strategy: input.strategy,
      slippageBps: input.slippageBps,
      cluster: "mainnet-beta",
      job,
    });
    if (!b.ok) throw new Error(b.reason);
    if (b.built.kind !== "atomic" || b.built.txs.length !== 1)
      throw new Error(
        "This mission adapter requires an atomic rebalance; account-creation stages need a separate review.",
      );
    // The native builder independently refreshes its own active-bin assumptions. Capacity reads are a disclosed separate context.
    executionActiveId = b.built.activeId;
    tx = b.built.txs[0]!.tx;
    target = b.built.target;
    maxActiveBinSlippage = b.built.maxActiveBinSlippage;
  } else if (input.action === "withdraw") {
    const b = await buildWithdraw({
      connection,
      owner,
      poolAddress: s.pool,
      position: s.position,
      bps: input.bps,
      cluster: "mainnet-beta",
      label: "Mission withdrawal",
      job,
    });
    tx = b.txs[0]!.tx;
    if (b.lower !== source.lower || b.upper !== source.upper)
      throw new Error("Position range changed during preparation.");
  } else {
    const position = await job.step(
      pool.getPosition(new PublicKey(s.position)),
      12_000,
      "Claim position",
    );
    if (
      !position.positionData.owner.equals(owner) ||
      position.positionData.lowerBinId !== source.lower ||
      position.positionData.upperBinId !== source.upper
    )
      throw new Error("Claim position identity/range changed.");
    const txs = await job.step(
      pool.claimSwapFee({ owner, position }),
      45_000,
      "Native claim build",
    );
    if (txs.length !== 1)
      throw new Error(
        "Wide/multiple claim transactions need separate reviews and are unsupported here.",
      );
    tx = txs[0]!;
  }
  const ranges = [source, ...(target ? [target] : [])],
    arrays = new Set<string>();
  for (const r of ranges) {
    const lo = sdk.binIdToBinArrayIndex(new BN(r.lower)).toNumber(),
      hi = sdk.binIdToBinArrayIndex(new BN(r.upper)).toNumber();
    if (hi - lo > 3) throw new Error("This position exceeds the verified execution coverage.");
    for (let i = lo; i <= hi; i++)
      arrays.add(sdk.deriveBinArray(pool.pubkey, new BN(i), pool.program.programId)[0].toBase58());
  }
  const binding: ExecutionBinding = {
    scope: s,
    action: input.action,
    reserveX: pool.lbPair.reserveX.toBase58(),
    reserveY: pool.lbPair.reserveY.toBase58(),
    binArrays: [...arrays],
    bitmap: sdk.deriveBinArrayBitmapExtension(pool.pubkey, pool.program.programId)[0].toBase58(),
    eventAuthority: PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("__event_authority")],
      pool.program.programId,
    )[0].toBase58(),
    source,
    target,
    activeId: executionActiveId,
    bps: input.bps,
    maxActiveBinSlippage,
  };
  const specs = specsOf(
    sdk.IDL as unknown as { instructions: ({ name: string } & InstructionSpec)[] },
  );
  const { BorshInstructionCoder } = await job.step(
    import("@coral-xyz/anchor"),
    12_000,
    "Installed IDL decoder",
  );
  const coder = new BorshInstructionCoder(sdk.IDL as unknown as Idl);
  const inspect = (t: Transaction) =>
    inspectMissionInstructions(t, binding, specs, (data) => coder.decode(Buffer.from(data)));
  const proof = inspect(tx);
  const costs = await reviewCosts(connection, owner, [tx], job);
  costCheck(costs);
  if (BigInt(costs.feeLamports!) > BigInt(policy.policy.maxNetworkFeeLamports))
    throw new Error("The network fee exceeds this mission's cap.");
  if (
    BigInt(costs.walletLamports!) <
    BigInt(costs.requiredLamports!) + BigInt(policy.policy.minSolReserveLamports)
  )
    throw new Error("This action would breach the minimum SOL reserve.");
  const hash = await instructionHash(tx),
    preparedAt = Date.now();
  const expiresAt = Math.min(
    preparedAt + 20_000,
    policy.policy.expiresAt,
    budget.expiresAt,
    snapshot.startedAt + policy.policy.maxAgeMs,
  );
  if (expiresAt <= preparedAt)
    throw new Error("Mission evidence expired during preparation. Rebuild.");
  job.check();
  const verifySource = async (conn: Connection, caller: Job) => {
    const read = await caller.step(
      conn.getMultipleAccountsInfoAndContext([new PublicKey(s.pool), new PublicKey(s.position!)], {
        commitment: "confirmed",
        minContextSlot: snapshot.slot,
      }),
      8000,
      "Fresh mission source identity",
    );
    const [pairInfo, positionInfo] = read.value;
    const disc = new Uint8Array(sdk.getAccountDiscriminator("lbPair"));
    if (
      !pairInfo ||
      pairInfo.executable ||
      !pairInfo.owner.equals(pool.program.programId) ||
      !disc.every((x, i) => pairInfo.data[i] === x) ||
      !positionInfo ||
      positionInfo.executable ||
      !positionInfo.owner.equals(pool.program.programId)
    )
      throw new Error("Fresh mission source account ownership differs.");
    const pair = pool.program.coder.accounts.decode("lbPair", pairInfo.data);
    const position = sdk.wrapPosition(pool.program, new PublicKey(s.position!), positionInfo);
    if (
      pair.status !== 0 ||
      pair.binStep !== s.binStep ||
      pair.tokenXMint.toBase58() !== s.mintX ||
      pair.tokenYMint.toBase58() !== s.mintY ||
      !position.owner().equals(owner) ||
      position.lbPair().toBase58() !== s.pool ||
      position.lowerBinId().toNumber() !== source.lower ||
      position.upperBinId().toNumber() !== source.upper
    )
      throw new Error("Mission pool, owner or position range changed. Rebuild.");
  };
  return {
    missionId,
    digest: policy.digest,
    budgetRevision: budget.revision,
    action: input.action,
    tx,
    label: `Conductor · ${input.action}`,
    snapshot,
    costs,
    binding,
    instructionHash: hash,
    instructionNames: proof.names,
    preparedAt,
    expiresAt,
    inspect: (t: Transaction) => {
      inspect(t);
    },
    verifySource,
  } satisfies BuiltMissionAction;
}

/** Commit proposed → reviewed → reserved before the shared runner is allowed to prompt. */
export async function reserveMissionAction(b: BuiltMissionAction) {
  const now = Date.now();
  if (now > b.expiresAt) throw new Error("Review expired. Rebuild before reserving.");
  const op = Operation.parse({
    id: newId("op"),
    scope: {
      missionId: b.missionId,
      owner: b.binding.scope.owner,
      cluster: "mainnet-beta",
      pool: b.binding.scope.pool,
      mintX: b.binding.scope.mintX,
      mintY: b.binding.scope.mintY,
    },
    budgetRevision: b.budgetRevision,
    policyDigest: b.digest,
    action: b.action,
    state: "proposed",
    reserved: { xRaw: "0", yRaw: "0", lamports: String(b.costs.requiredLamports) },
    consumed: null,
    messageHash: null,
    instructionHash: b.instructionHash,
    signature: null,
    blockhash: null,
    lastValidBlockHeight: null,
    evidence: null,
    history: [{ state: "proposed", at: now }],
  });
  await proposeOperation(op);
  try {
    const reviewed = await transitionOperation(op.id, 1, "reviewed");
    return await transitionOperation(op.id, reviewed.row, "reserved");
  } catch (e) {
    await rejectUnsignedOperation(op.scope.missionId, op.id, String(e)).catch(() => {});
    throw e;
  }
}

export async function recordMissionReview(b: BuiltMissionAction, row: OperationRow) {
  if (await getRecord(row.id)) throw new Error("Recorder ID collision. Nothing was signed.");
  await recordFact({
    id: row.id,
    kind: "review",
    title: `Conductor ${b.action} · budget v${b.budgetRevision}`,
    route: "/app/conductor",
    cluster: "mainnet-beta",
    wallet: b.binding.scope.owner,
    links: { proposalId: row.id },
    context: {
      missionId: b.missionId,
      policyDigest: b.digest,
      budgetRevision: b.budgetRevision,
      instructionHash: b.instructionHash,
      reservedLamports: row.op.reserved.lamports,
      pool: b.binding.scope.pool,
      position: b.binding.scope.position,
      journeyId: b.binding.scope.journeyId,
      action: b.action,
      tokenTopUpXRaw: "0",
      tokenTopUpYRaw: "0",
      scope: "local-device-mission",
      expiresAt: b.expiresAt,
    },
    detail:
      "Local policy-checked native review. One fresh wallet approval; no delegated signing. Cumulative SOL budget counts gross funding plus network fees; refunds are not automatically credited.",
  });
  const stored = await getRecord(row.id);
  if (
    usingMemoryFallback() ||
    stored?.provenance !== "this-device" ||
    stored.context["instructionHash"] !== b.instructionHash
  )
    throw new Error("Durable Recorder review unavailable; nothing was signed.");
}

export function missionPolicyGuard(
  connection: Connection,
  b: BuiltMissionAction,
  original: OperationRow,
  controller?: JobControl,
): NonNullable<TxContext["policyGuard"]> {
  let row = original;
  const check = async (tx: Transaction) => {
    if (Date.now() > b.expiresAt) throw new Error("Mission review expired; rebuild.");
    b.inspect(tx);
    if ((await instructionHash(tx)) !== b.instructionHash)
      throw new Error("Reviewed instruction identity changed.");
    const local = await readExecutionState(b.missionId),
      p = MissionPolicyRevision.parse(local.mission.policies.at(-1));
    if (p.digest !== b.digest || (await missionPolicyDigest(p.policy)) !== p.digest)
      throw new Error("Mission policy changed during approval.");
    const budget = assertBudget(local.mission, local.budgets.at(-1)?.budget);
    if (budget.revision !== b.budgetRevision)
      throw new Error("Execution budget changed during approval.");
    const stored = local.operations.find((o) => o.id === row.id);
    if (!stored || stored.row !== row.row || stored.op.state !== "reserved")
      throw new Error("The reservation changed or was cancelled.");
    if (
      stored.op.policyDigest !== b.digest ||
      stored.op.budgetRevision !== b.budgetRevision ||
      stored.op.instructionHash !== b.instructionHash ||
      stored.op.action !== b.action ||
      stored.op.scope.owner !== b.binding.scope.owner ||
      stored.op.scope.pool !== b.binding.scope.pool ||
      stored.op.scope.mintX !== b.binding.scope.mintX ||
      stored.op.scope.mintY !== b.binding.scope.mintY ||
      stored.op.scope.cluster !== "mainnet-beta" ||
      stored.op.reserved.xRaw !== "0" ||
      stored.op.reserved.yRaw !== "0" ||
      stored.op.reserved.lamports !== String(b.costs.requiredLamports)
    )
      throw new Error("Stored reservation differs from the independently reviewed action.");
    const confirmedAt = local.operations
      .filter((o) => o.op.state === "confirmed")
      .reduce((at, o) => Math.max(at, o.op.history.at(-1)!.at), 0);
    if (confirmedAt && Date.now() - confirmedAt < p.policy.cooldownMs)
      throw new Error("Mission action cooldown is still active.");
    if (Date.now() - b.snapshot.startedAt > p.policy.maxAgeMs || Date.now() < b.snapshot.observedAt)
      throw new Error("Mission evidence is stale or from the future.");
    const ctl = controller ?? new JobControl(),
      job = ctl.begin();
    if (!job) throw new Error("Waiting for an earlier policy read to drain.");
    try {
      await b.verifySource(connection, job);
      const costs = await reviewCosts(connection, new PublicKey(b.binding.scope.owner), [tx], job);
      costCheck(costs);
      if (
        BigInt(costs.feeLamports!) > BigInt(p.policy.maxNetworkFeeLamports) ||
        BigInt(costs.requiredLamports!) > BigInt(row.op.reserved.lamports)
      )
        throw new Error("Fresh costs exceed the reserved amount or fee cap. Rebuild.");
      if (
        BigInt(costs.walletLamports!) <
        BigInt(costs.requiredLamports!) + BigInt(p.policy.minSolReserveLamports)
      )
        throw new Error("Fresh funding would breach the mission's SOL reserve.");
    } finally {
      if (!controller) ctl.unmount();
      ctl.end(job);
    }
    if (Date.now() > b.expiresAt) throw new Error("Mission review expired during verification.");
    const again = await readExecutionState(b.missionId);
    if (
      again.mission.policies.at(-1)!.digest !== b.digest ||
      again.budgets.at(-1)?.budget.revision !== b.budgetRevision ||
      again.operations.find((o) => o.id === row.id)?.row !== row.row
    )
      throw new Error("Mission or reservation changed during verification.");
  };
  return {
    beforeSign: async (tx) => {
      await check(tx);
    },
    beforeBroadcast: async (tx, bytes, pending) => {
      await check(tx);
      row = await transitionOperation(row.id, row.row, "signed", {
        signature: pending.signature,
        blockhash: pending.blockhash,
        lastValidBlockHeight: pending.lastValidBlockHeight,
        messageHash: await executionHash(bytes),
        evidence: `review:${row.id}`,
      });
      row = await transitionOperation(row.id, row.row, "submitted");
    },
  };
}

export async function rejectUnsignedOperation(
  missionId: string,
  id: string,
  reason = "Cancelled before broadcast",
) {
  const l = await readExecutionState(missionId),
    row = l.operations.find((o) => o.id === id);
  if (!row || !["proposed", "reviewed", "reserved"].includes(row.op.state) || row.op.signature)
    return false;
  await transitionOperation(id, row.row, "rejected", { evidence: redact(reason).slice(0, 400) });
  return true;
}

/** No resend, no timer-based release. A missing receipt leaves the full reservation held. */
export async function reconcileMissionOperation(
  connection: Connection,
  missionId: string,
  id: string,
) {
  const local = await readExecutionState(missionId);
  let row = local.operations.find((o) => o.id === id);
  if (!row) throw new Error("Operation not found.");
  if (["confirmed", "failed", "expired", "rejected"].includes(row.op.state))
    return "Already settled.";
  const op = row.op;
  if (!op.signature || !op.blockhash || op.lastValidBlockHeight === null || !op.messageHash)
    return "Unsigned reservation. Cancel its review to release it.";
  await assertCluster(connection, op.scope.cluster);
  if (row.op.state === "signed" || row.op.state === "submitted")
    row = await transitionOperation(id, row.row, "unknown");
  const status = await checkSignature(connection, op.signature, op.lastValidBlockHeight);
  if (status.kind === "expired") {
    await transitionOperation(id, row.row, "expired", {
      independentlyVerified: true,
      evidence: "Verified history absence after blockhash expiry; no transaction landed.",
    });
    return "Expiry independently verified. Reservation released.";
  }
  if (status.kind !== "confirmed")
    return status.kind === "unknown"
      ? `Reservation held: ${redact(status.reason)}`
      : "Signature remains pending; reservation held.";
  try {
    const receipt = await withTimeout(
      connection.getTransaction(op.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
      12_000,
      "Operation receipt",
    );
    if (receipt?.transaction.signatures[0] !== op.signature)
      throw new Error("Receipt signature differs.");
    const verified = await verifiedOperationSpend(receipt, {
      owner: op.scope.owner,
      messageHash: op.messageHash,
      mintX: op.scope.mintX,
      mintY: op.scope.mintY,
    });
    if (verified.failed !== !!status.err)
      throw new Error("Status and transaction receipt disagree.");
    await transitionOperation(id, row.row, verified.failed ? "failed" : "confirmed", {
      consumed: verified.spend,
      independentlyVerified: true,
      evidence: `Verified getTransaction at slot ${verified.slot}. Gross owner funding + charged network fee; token debits are not PnL.`,
    });
    return verified.failed
      ? "On-chain failure verified; charged network fee recorded, unused reservation released."
      : "Confirmed receipt and exact spending verified. Budget settled.";
  } catch (e) {
    return `Reservation held until cost evidence is available: ${redact((e as Error).message)}`;
  }
}

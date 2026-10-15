// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Keypair, Transaction, SystemProgram, type Connection } from "@solana/web3.js";
import { runTransaction, GENESIS } from "@/lib/tx";
import { instructionHash } from "@/lib/conductor-execution-proof";
import { missionPolicy, missionSnapshot, at } from "./conductor-fixtures";
vi.mock("@/lib/agents-chain", () => ({
  reviewCosts: async () => ({
    feeLamports: 5000,
    requiredLamports: 10000,
    walletLamports: 1_000_000_000,
    remaining: 0,
    simErrors: [],
    perTxFee: [5000],
    sizes: [300],
    units: [10000],
    logs: [],
    solOutLamports: 10000,
  }),
  buildNativeRebalance: vi.fn(),
  buildWithdraw: vi.fn(),
}));
let clock = at + 2000;
beforeEach(() => {
  vi.resetModules();
  clock = at + 2000;
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
function rpc() {
  const send = vi.fn(async () => "unused-mock-signature");
  const connection = {
    getGenesisHash: async () => GENESIS["mainnet-beta"],
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
    }),
    getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async () => ({ context: { slot: 100 }, value: { err: null, logs: [] } }),
    sendRawTransaction: send,
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 101 }],
    }),
  } as unknown as Connection;
  return { connection, send };
}
async function setup() {
  const c = await import("@/lib/conductor"),
    store = await import("@/lib/conductor-store"),
    ledger = await import("@/lib/ledger-store"),
    execution = await import("@/lib/conductor-execution");
  const owner = Keypair.generate(),
    scope = { ...missionPolicy().scope, owner: owner.publicKey.toBase58() };
  const p = await c.sealMissionPolicy({ ...missionPolicy(), scope }, 1, at);
  const snapshot = { ...missionSnapshot(), scope };
  const mission = await store.saveNewMission(
    c.createConductorMission("Runner boundary", p, snapshot),
  );
  const budget = {
    v: 1 as const,
    kind: "cumulative-execution-budget" as const,
    scope: {
      missionId: mission.id,
      owner: scope.owner,
      cluster: "mainnet-beta" as const,
      pool: scope.pool,
      mintX: scope.mintX,
      mintY: scope.mintY,
    },
    revision: 1,
    policyDigest: p.digest,
    totalXRaw: "0",
    totalYRaw: "0",
    totalLamports: "100000",
    allowedActions: ["claim" as const],
    expiresAt: p.policy.expiresAt,
  };
  await ledger.sealBudget(budget, null);
  // Synthetic transaction: this test targets shared-runner timing/storage, not the separately tested native decoder.
  const tx = new Transaction({
    feePayer: owner.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  const b = {
    missionId: mission.id,
    digest: p.digest,
    budgetRevision: 1,
    action: "claim",
    tx,
    label: "Synthetic boundary test",
    snapshot,
    costs: { requiredLamports: 10000 },
    binding: { scope },
    instructionHash: await instructionHash(tx),
    preparedAt: clock,
    expiresAt: clock + 20000,
    inspect: () => {},
    verifySource: async () => {},
  } as unknown as import("@/lib/conductor-execution").BuiltMissionAction;
  const row = await execution.reserveMissionAction(b);
  return { c, store, ledger, execution, owner, mission, p, budget, b, row };
}
describe("Conductor shared simulate/sign/broadcast boundary", () => {
  it("never asks for a signature when a policy storage check refuses", async () => {
    const { connection, send } = rpc(),
      owner = Keypair.generate(),
      sign = vi.fn();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    await expect(
      runTransaction({
        connection,
        wallet: { publicKey: owner.publicKey, signTransaction: sign },
        tx,
        ctx: {
          cluster: "mainnet-beta",
          rpc: "relay",
          policyGuard: {
            beforeSign: async () => {
              throw new Error("Durable storage unavailable");
            },
            beforeBroadcast: async () => {},
          },
        },
      }),
    ).rejects.toThrow(/storage unavailable/);
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["policy", "budget"])(
    "a %s revision change during wallet approval discards signed bytes",
    async (kind) => {
      const f = await setup(),
        { connection, send } = rpc();
      const sign = vi.fn(async (tx: Transaction) => {
        clock += 1000;
        if (kind === "policy") {
          const p = await f.c.sealMissionPolicy({ ...f.p.policy, maxImpactBps: 60 }, 2, clock);
          await f.store.appendMissionPolicy(f.mission.id, f.mission.revision, p);
        } else await f.ledger.sealBudget({ ...f.budget, revision: 2 }, 1);
        tx.partialSign(f.owner);
        return tx;
      });
      await expect(
        runTransaction({
          connection,
          wallet: { publicKey: f.owner.publicKey, signTransaction: sign },
          tx: f.b.tx,
          ctx: {
            cluster: "mainnet-beta",
            rpc: "relay",
            policyGuard: f.execution.missionPolicyGuard(connection, f.b, f.row),
          },
        }),
      ).rejects.toThrow(/changed/);
      expect(sign).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
      expect((await f.ledger.listLedger(f.mission.id)).operations[0]!.op.state).toBe("reserved");
      await f.execution.rejectUnsignedOperation(f.mission.id, f.row.id);
      expect((await f.ledger.listLedger(f.mission.id)).operations[0]!.op.state).toBe("rejected");
    },
  );
  it("persists signature, exact message and submission before broadcast and retains liability", async () => {
    const f = await setup(),
      { connection, send } = rpc();
    send.mockImplementation(async () => {
      const row = (await f.ledger.listLedger(f.mission.id)).operations[0]!;
      expect(row.op.state).toBe("submitted");
      expect(row.op.messageHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.op.signature).toBeTruthy();
      expect(row.op.blockhash).toBeTruthy();
      return "unused-mock-signature";
    });
    await runTransaction({
      connection,
      wallet: {
        publicKey: f.owner.publicKey,
        signTransaction: async (tx) => {
          tx.partialSign(f.owner);
          return tx;
        },
      },
      tx: f.b.tx,
      ctx: {
        cluster: "mainnet-beta",
        rpc: "relay",
        policyGuard: f.execution.missionPolicyGuard(connection, f.b, f.row),
      },
    });
    expect(send).toHaveBeenCalledOnce();
    const l = await f.ledger.listLedger(f.mission.id);
    expect(f.ledger.summarize(l.budgets, l.operations)!.reserved.lamports).toBe("10000");
    // Confirmation status alone does not release budget; exact receipt/cost reconciliation is still required.
    expect(l.operations[0]!.op.state).toBe("submitted");
  });
});

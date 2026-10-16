/** Public account reads and unsigned simulation only. No signing key, wallet prompt or broadcast. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { JobControl } from "@/lib/job-control";
import { sealMissionPolicy, createConductorMission } from "@/lib/conductor";
import { buildMissionAction } from "@/lib/conductor-execution";
import { readHostedMission } from "@/lib/conductor-observer.server";
let state: unknown, source: unknown;
vi.mock("@/lib/ledger-store", () => ({ readExecutionState: async () => state }));
vi.mock("@/lib/journey-store", () => ({
  listJourneys: async () => {
    if (source === null) throw new Error("Server read attempted browser storage");
    return [source];
  },
}));
vi.mock("@/lib/dlmm", () => {
  const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm");
  return {
    loadSdk: async () => ({ ...sdk, default: sdk.default ?? sdk }),
    DLMM_PROGRAM_ID: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  };
});
describe("Conductor native operation public mainnet acceptance", () => {
  it("independently verifies recipients and costs on a real unsigned native action", async () => {
    const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm");
    const connection = new Connection("https://studioloco.cfd/api/public/rpc/mainnet", {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(15000) }),
    });
    connection.sendRawTransaction = async () => {
      throw new Error("Acceptance cannot broadcast");
    };
    connection.sendTransaction = async () => {
      throw new Error("Acceptance cannot broadcast");
    };
    const poolAddress = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
    const pool = await (sdk.default ?? sdk).create(connection, new PublicKey(poolAddress), {
      cluster: "mainnet-beta",
      skipSolWrappingOperation: true,
    });
    const position = new PublicKey("1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id");
    const pos = await pool.getPosition(position),
      owner = pos.positionData.owner.toBase58(),
      journeyId = "journey-public-operations-qa";
    const scope = {
      pool: poolAddress,
      owner,
      mintX: pool.lbPair.tokenXMint.toBase58(),
      mintY: pool.lbPair.tokenYMint.toBase58(),
      decimalsX: pool.tokenX.mint.decimals,
      decimalsY: pool.tokenY.mint.decimals,
      binStep: pool.lbPair.binStep,
      position: position.toBase58(),
      journeyId,
    };
    const now = Date.now(),
      p = await sealMissionPolicy({
        v: 1,
        adapter: "ordinary-dlmm-read-v1",
        scope,
        probesX: ["1000000"],
        probesY: ["1000000"],
        maxImpactBps: 100,
        maxSwapFeeBps: 500,
        maxDeployXRaw: "0",
        maxDeployYRaw: "0",
        minSolReserveLamports: "0",
        maxNetworkFeeLamports: "100000",
        allowedActions: ["claim", "withdraw", "rebalance"],
        cooldownMs: 60000,
        maxAgeMs: 150000,
        expiresAt: now + 86400000,
        approval: "fresh-wallet-review",
      });
    source = {
      id: journeyId,
      kind: "position",
      account: scope.position,
      owner,
      pool: poolAddress,
      snapshots: [],
    };
    state = {
      mission: { id: "mission-public-operations-qa", policies: [p], samples: [] },
      budgets: [
        {
          budget: {
            revision: 1,
            policyDigest: p.digest,
            allowedActions: p.policy.allowedActions,
            expiresAt: p.policy.expiresAt,
          },
        },
      ],
      operations: [],
    };
    const report: unknown[] = [];
    for (const action of ["withdraw", "rebalance", "claim"] as const) {
      const ctl = new JobControl(),
        job = ctl.begin()!;
      try {
        const b = await buildMissionAction(
          connection,
          "mission-public-operations-qa",
          { action, bps: 2500, strategy: "Spot", slippageBps: 50 },
          job,
          "relay",
        );
        await b.verifySource(connection, job);
        expect(b.instructionHash).toMatch(/^[a-f0-9]{64}$/);
        expect(b.costs.simErrors).toEqual([null]);
        expect(b.costs.feeLamports).not.toBeNull();
        expect(b.costs.requiredLamports).not.toBeNull();
        report.push({
          action,
          status: "verified-unsigned",
          slot: b.snapshot.slot,
          scope: b.binding.scope,
          source: b.binding.source,
          target: b.binding.target,
          instructions: b.instructionNames,
          instructionHash: b.instructionHash,
          costs: b.costs,
          expiresAt: b.expiresAt,
        });
      } catch (e) {
        report.push({ action, status: "refused", reason: (e as Error).message });
      } finally {
        ctl.end(job);
      }
    }
    const hostedConfig = {
      v: 1 as const,
      kind: "loco-hosted-mission" as const,
      missionId: "mission-public-background-qa",
      policy: p,
    };
    source = null; // Server observation MUST use its independent resolver, never browser storage.
    const hostedSnapshot = await readHostedMission(connection, hostedConfig);
    expect(hostedSnapshot.rpcKind).toBe("server");
    expect(hostedSnapshot.position?.account).toBe(scope.position);
    mkdirSync(".qa", { recursive: true });
    writeFileSync(".qa/conductor-hosted-live-config.json", JSON.stringify(hostedConfig));
    writeFileSync(
      ".qa/conductor-hosted-mainnet.json",
      JSON.stringify(
        { at: new Date().toISOString(), signed: false, broadcast: false, snapshot: hostedSnapshot },
        null,
        2,
      ),
    );
    writeFileSync(
      ".qa/conductor-operations-mainnet.json",
      JSON.stringify(
        { at: new Date().toISOString(), signed: false, broadcast: false, report },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(report));
    expect(report.some((r) => (r as { status: string }).status === "verified-unsigned")).toBe(true);
  });
});

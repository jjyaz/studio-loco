/** Public read-only acceptance. No wallet key, signature or transaction submission. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { JobControl } from "@/lib/job-control";
import { readConductorSnapshot } from "@/lib/conductor-chain";
import {
  evaluateMission,
  sealMissionPolicy,
  createConductorMission,
  exportMission,
  analyzeMissionExport,
  missionQuoteMetrics,
} from "@/lib/conductor";
vi.mock("@/lib/dlmm", () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const sdk = require("@meteora-ag/dlmm");
  return {
    loadSdk: async () => ({ ...sdk, default: sdk.default ?? sdk }),
    DLMM_PROGRAM_ID: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  };
});
describe("Conductor public mainnet acceptance", () => {
  it("reads coherent two-way native quotes, owner inventory and export analysis without signing", async () => {
    const connection = new Connection("https://studioloco.cfd/api/public/rpc/mainnet", {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
    });
    connection.sendRawTransaction = async () => {
      throw new Error("Conductor QA cannot broadcast");
    };
    connection.sendTransaction = async () => {
      throw new Error("Conductor QA cannot broadcast");
    };
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const input = {
      pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
      owner: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD",
      probesX: ["1000000", "10000000", "100000000"],
      probesY: ["1000000", "10000000", "100000000"],
    };
    try {
      const inspected = await readConductorSnapshot(
        connection,
        { ...input, probesX: [], probesY: [] },
        job,
        "relay",
      );
      const policy = await sealMissionPolicy({
        v: 1,
        adapter: "ordinary-dlmm-read-v1",
        scope: inspected.scope,
        probesX: input.probesX,
        probesY: input.probesY,
        maxImpactBps: 50,
        maxSwapFeeBps: 100,
        maxDeployXRaw: "0",
        maxDeployYRaw: "0",
        minSolReserveLamports: "0",
        maxNetworkFeeLamports: "100000",
        allowedActions: ["rebalance", "claim", "withdraw"],
        cooldownMs: 300000,
        maxAgeMs: 150000,
        expiresAt: Date.now() + 86400000,
        approval: "fresh-wallet-review",
      });
      const snapshot = await readConductorSnapshot(
        connection,
        { ...input, expectedScope: inspected.scope, minimumSlot: inspected.slot },
        job,
        "relay",
      );
      expect(snapshot.slot).toBeGreaterThanOrEqual(inspected.slot);
      expect(snapshot.binArrays.length).toBeLessThanOrEqual(4);
      expect(snapshot.quotes).toHaveLength(6);
      expect(snapshot.funds).not.toBeNull();
      expect(snapshot.funds!.slot).toBeGreaterThanOrEqual(snapshot.slot);
      const quoted = snapshot.quotes.filter((q) => q.status === "quoted");
      expect(quoted.length).toBeGreaterThan(0);
      for (const q of quoted) {
        expect(q.consumedRaw).toBe(q.inputRaw);
        expect(missionQuoteMetrics(q, snapshot.referencePriceQ64)).not.toBeNull();
      }
      const mission = createConductorMission("Public read-only QA", policy, snapshot);
      const report = await analyzeMissionExport(exportMission(mission));
      expect(report.independentlyVerified).toBe(false);
      const health = evaluateMission(policy.policy, snapshot);
      mkdirSync(".qa", { recursive: true });
      writeFileSync(
        ".qa/conductor-mainnet.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            signed: false,
            broadcast: false,
            snapshot,
            health,
            report,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          stage: "conductor-mainnet",
          slot: snapshot.slot,
          scope: snapshot.scope,
          quotes: snapshot.quotes.length,
          fullQuotes: quoted.length,
          state: health.state,
          metrics: quoted.map((q) => ({
            direction: q.direction,
            inputRaw: q.inputRaw,
            ...missionQuoteMetrics(q, snapshot.referencePriceQ64),
          })),
        }),
      );
    } finally {
      ctl.end(job);
    }
  });
});

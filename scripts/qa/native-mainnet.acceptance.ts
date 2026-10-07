import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { JobControl } from "@/lib/job-control";
import { buildNativeRebalance } from "@/lib/agents-chain";

// The Node harness loads the package's Node entry. The product continues to use its browser entry.
vi.mock("@/lib/dlmm", () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const sdk = require("@meteora-ag/dlmm");
  return { loadSdk: async () => ({ ...sdk, default: sdk.default ?? sdk }) };
});
const require = createRequire(new URL("../../package.json", import.meta.url));
const sdk = require("@meteora-ag/dlmm");

describe("explicit read-only mainnet native acceptance", () => {
  it("builds and exactly simulates a native rebalance without signing or broadcasting", async () => {
    const report: Record<string, unknown> = { at: new Date().toISOString(), network: "mainnet-beta", signed: false, broadcast: false, calls: [], stages: [] };
    let lastPost: { addresses: string[]; accounts: { owner: string; lamports: number; data: string[]; executable: boolean; rentEpoch: number }[] } | undefined;
    const calls = report.calls as { method: string; elapsedMs: number; status?: number; error?: string }[];
    const connection = new Connection("https://studioloco.cfd/api/public/rpc/mainnet", {
      commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: async (url, options) => {
        const body = JSON.parse(String(options?.body ?? "{}"));
        const method = body.method as string;
        const start = Date.now();
        try {
          const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
          calls.push({ method, elapsedMs: Date.now() - start, status: res.status });
          console.log(JSON.stringify(calls.at(-1)));
          if (method === "simulateTransaction" && body.params?.[1]?.accounts?.addresses) {
            const json = await res.clone().json();
            lastPost = { addresses: body.params[1].accounts.addresses, accounts: json.result?.value?.accounts ?? [] };
          }
          return res;
        } catch (e) {
          calls.push({ method, elapsedMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      },
    });
    connection.sendRawTransaction = async () => { throw new Error("This acceptance test cannot broadcast."); };
    connection.sendTransaction = async () => { throw new Error("This acceptance test cannot broadcast."); };
    try {
      expect(await connection.getGenesisHash()).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
      const poolAddress = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
      const pool = await (sdk.default ?? sdk).create(connection, new PublicKey(poolAddress), { cluster: "mainnet-beta", skipSolWrappingOperation: true });
      const accounts = await connection.getProgramAccounts(new PublicKey(sdk.LBCLMM_PROGRAM_IDS["mainnet-beta"]), {
        commitment: "confirmed", filters: [sdk.positionV2Filter(), sdk.positionLbPairFilter(new PublicKey(poolAddress))], dataSlice: { offset: 0, length: 72 },
      });
      let selected: { key: PublicKey; positionData: { owner: PublicKey; lowerBinId: number; upperBinId: number; totalXAmount: string; totalYAmount: string } } | undefined;
      for (let i = 0; i < Math.min(60, accounts.length); i += 10) {
        const part = await Promise.all(accounts.slice(i, i + 10).map(async (a) => ({ key: a.pubkey, positionData: (await pool.getPosition(a.pubkey)).positionData })));
        selected = part.find((p) => {
          const w = p.positionData.upperBinId - p.positionData.lowerBinId + 1;
          return w >= 5 && w <= 69 && w % 2 === 1 && (Number(p.positionData.totalXAmount) + Number(p.positionData.totalYAmount)) > 0;
        });
        if (selected) break;
      }
      if (!selected) throw new Error("No suitable nonempty native test position was found among 60 public accounts.");
      if (process.env["LOCO_QA_EVEN"] === "1") {
        const key = new PublicKey("1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id");
        selected = { key, positionData: (await pool.getPosition(key)).positionData };
        expect((selected.positionData.upperBinId - selected.positionData.lowerBinId + 1) % 2).toBe(0);
      }
      const strategy = process.env["LOCO_QA_STRATEGY"] ?? "Spot";
      if (strategy !== "Spot" && strategy !== "Curve" && strategy !== "BidAsk") throw new Error("Unsupported acceptance strategy.");
      report.strategy = strategy;
      const width = selected.positionData.upperBinId - selected.positionData.lowerBinId + 1;
      report.position = selected.key.toBase58();
      report.pool = poolAddress;
      report.width = width;
      const control = new JobControl();
      const job = control.begin()!;
      // A diagnostic mode isolates whether the previous 12s timeout was the composed SDK stage.
      // It does not change production limits and still tracks original work in JobControl.
      const step = job.step.bind(job);
      job.step = async (p, ms, label) => {
        const started = Date.now();
        try { return await step(p, process.env["LOCO_QA_DIAGNOSTIC"] === "1" && label === "Rebalance instructions" ? 45_000 : ms, label); }
        finally { (report.stages as unknown[]).push({ label, elapsedMs: Date.now() - started }); }
      };
      try {
        const result = await buildNativeRebalance({ connection, owner: selected.positionData.owner, poolAddress, position: selected.key.toBase58(), strategy, slippageBps: 50, cluster: "mainnet-beta", job });
        if (!result.ok) throw new Error(result.reason);
        const b = result.built;
        report.result = { kind: b.kind, target: b.target, deposited: b.deposited, walletOut: b.walletOut, costs: { feeLamports: b.costs.feeLamports, requiredLamports: b.costs.requiredLamports, sizes: b.costs.sizes, units: b.costs.units, simErrors: b.costs.simErrors, remaining: b.costs.remaining }, logs: b.costs.logs };
        expect(b.kind).toBe("atomic");
        expect(b.target.upper - b.target.lower + 1).toBe(width);
        expect(b.costs.simErrors).toEqual([null]);
        expect(b.costs.feeLamports).toBeGreaterThan(0);
        expect(b.costs.requiredLamports).not.toBeNull();
        const post = lastPost?.accounts[lastPost.addresses.indexOf(selected.key.toBase58())];
        if (!post || post.data[1] !== "base64") throw new Error("Native simulation returned no position post-state.");
        const wrapped = sdk.wrapPosition(pool.program, selected.key, { ...post, owner: new PublicKey(post.owner), data: Buffer.from(post.data[0]!, "base64") });
        const actual = { lower: wrapped.lowerBinId().toNumber(), upper: wrapped.upperBinId().toNumber() };
        expect(actual).toEqual(b.target);
        expect(wrapped.owner().equals(selected.positionData.owner)).toBe(true);
        expect(wrapped.lbPair().toBase58()).toBe(poolAddress);
        report.simulatedPositionRange = actual;
        report.passed = true;
      } finally { control.end(job); }
    } catch (e) {
      report.passed = false;
      report.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      mkdirSync("docs/qa", { recursive: true });
      writeFileSync("docs/qa/native-mainnet-acceptance.json", JSON.stringify(report, null, 2) + "\n");
      if (report.strategy) writeFileSync(`docs/qa/native-mainnet-${process.env["LOCO_QA_EVEN"] === "1" ? "even" : "odd"}-${report.strategy}.json`, JSON.stringify(report, null, 2) + "\n");
    }
  });
});

/** Explicitly invoked read-only protocol acceptance; no wallet/keys/signatures/broadcasts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { prepareDepotLaunch, checkDepotFreshCosts, depotActionGuard, readDepotLifecycle } from "@/lib/depot-chain";
import { getPreset, launchMath, type Recipient, type ReviewBinding } from "@/lib/depot";
import { createRpcFetch } from "@/lib/rpc-fetch";

describe("Depot unsigned mainnet protocol acceptance", () => {
  it("builds, prices, checks and exactly simulates the app adapter without signing", async () => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    const origin = "https://studioloco.cfd";
    const imageUrl = `${origin}/api/public/depot/image/${"a".repeat(64)}`;
    const body = JSON.stringify({ name: "Loco QA Scout", symbol: "LQA", description: "Unsigned protocol QA fixture, not a published agent or token.", image: imageUrl });
    const metadataHash = createHash("sha256").update(body).digest("hex"), metadataUri = `${origin}/api/public/depot/metadata/${metadataHash}`;
    const originalFetch = globalThis.fetch;
    // This single metadata read is a labelled fixture. Every RPC is a real mainnet read/simulation.
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) === metadataUri) return new Response(body, { headers: { "Content-Type": "application/json" } });
      return originalFetch(url, init);
    });
    let postSlot = 0;
    const simulatedAccounts = new Map<string, { owner: string; data: [string, string]; lamports: number; executable: boolean; rentEpoch: number }>();
    const connection = new Connection("https://solana-rpc.publicnode.com", { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: createRpcFetch(async (url, init) => {
      const response = await originalFetch(url, init);
      const request = JSON.parse(String(init?.body ?? "{}"));
      if (request.method === "simulateTransaction" && request.params?.[1]?.accounts?.addresses) {
        const json = await response.clone().json();
        postSlot = json.result?.context?.slot ?? 0;
        for (const [i, key] of (request.params[1].accounts.addresses as string[]).entries()) {
          const a = json.result?.value?.accounts?.[i]; if (a) simulatedAccounts.set(key, a);
        }
      }
      return response;
    }) });
    connection.sendTransaction = async () => { throw new Error("Broadcast disabled in this acceptance harness"); };
    connection.sendRawTransaction = async () => { throw new Error("Broadcast disabled in this acceptance harness"); };
    const wallet = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD";
    const roles: Recipient["role"][] = ["payer", "creator", "fee-claimer", "leftover-receiver", "locked-lp-owner"];
    const binding: ReviewBinding = { wallet, cluster: "mainnet-beta", rpc: "public", rpcGeneration: 1, agentId: "unsigned-qa-only", agentRevision: 1, presetId: "small-sol-20", presetVersion: 1, metadataUri, metadataHash, recipients: roles.map(role => ({ role, address: wallet })), maxStageLamports: 200_000_000n, maxTotalLamports: 200_000_000n };
    const report: Record<string, unknown> = { at: new Date().toISOString(), signed: false, broadcast: false, scope: "App chain adapter protocol acceptance. Metadata is an in-memory QA fixture, not publicly published. No account session, wallet proof, holder gate or funded browser signing is exercised.", wallet, preset: binding.presetId };
    try {
      const p = await prepareDepotLaunch(connection, binding, { name: "Loco QA Scout", symbol: "LQA", description: "Unsigned protocol QA fixture, not a published agent or token.", imageUrl, metadataUri }, origin);
      expect(p.kind).toBe("launch");
      expect(p.signers).toHaveLength(2);
      expect(depotActionGuard(p, binding, p.tx)).toBeNull();
      await checkDepotFreshCosts(connection, p, p.tx);
      // Verify the actual program's SIMULATED post-state decoder without claiming a deployed launch.
      const accountReader = connection.getMultipleAccountsInfoAndContext;
      connection.getMultipleAccountsInfoAndContext = async keys => ({ context: { slot: postSlot }, value: keys.map(key => {
        const a = simulatedAccounts.get(key.toBase58());
        if (!a || a.data[1] !== "base64") throw new Error("Missing simulated launch account");
        return { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64") };
      }) });
      const lifecycle = await readDepotLifecycle(connection, p.target, wallet, "mainnet-beta");
      connection.getMultipleAccountsInfoAndContext = accountReader;
      expect(lifecycle.status).toBe("bonding");
      expect(lifecycle.creatorQuoteFeeRaw).toBe("0");
      expect(lifecycle.thresholdRaw).toBe("20000000000");
      expect(lifecycle.readContexts).toHaveLength(1);
      const s = p.review.stages[0]!;
      expect(s.feeLamports).toBeGreaterThan(0n);
      expect(s.rentLamports).toBeGreaterThan(0n);
      const compiled = p.tx.compileMessage();
      report.result = { target: p.target, slot: p.observedSlot, feeLamports: s.feeLamports!.toString(), rentLamports: s.rentLamports!.toString(), packetBytes: compiled.serialize().length + 1 + compiled.header.numRequiredSignatures * 64, requiredSignatures: compiled.header.numRequiredSignatures, rawSupply: launchMath(getPreset(binding.presetId, 1)).rawSupply.toString(), metadataBytes: new TextEncoder().encode(metadataUri).length, simulation: "passed twice: preparation and fresh-cost recheck", instructionProof: "official installed-IDL account and recipient checks passed" };
      report.simulatedPostStateOnly = { slot: lifecycle.slot, phase: lifecycle.status, protocolMigrationFeeBps: lifecycle.protocolMigrationFeeBps, identity: "Program-owned mint/config/pool PDAs, removed mint/freeze authorities and locked creator LP allocation decoded successfully from program simulation output. These accounts were NOT created on chain." };
    } catch (e) { report.error = e instanceof Error ? e.message : String(e); throw e; }
    finally { vi.unstubAllGlobals(); mkdirSync(".qa", { recursive: true }); writeFileSync(".qa/depot-unsigned-mainnet.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
  });
});

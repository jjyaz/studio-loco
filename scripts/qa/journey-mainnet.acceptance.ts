/** Explicit public-account QA. Cannot sign or send; no wallet keys or private records. */
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { JobControl } from "@/lib/job-control";
import { readJourneySnapshot } from "@/lib/journey-chain";
import { appendSnapshot, newJourney, transactionProof } from "@/lib/journey";
vi.mock("@/lib/dlmm", () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const sdk = require("@meteora-ag/dlmm");
  return { loadSdk: async () => ({ ...sdk, default: sdk.default ?? sdk }) };
});
const require = createRequire(new URL("../../package.json", import.meta.url));
const sdk = require("@meteora-ag/dlmm");
describe("Journey public mainnet acceptance", () => {
  it("verifies LP snapshots and a live native order without signing or broadcasting", async () => {
    const report: Record<string, unknown> = {
      at: new Date().toISOString(),
      network: "mainnet-beta",
      signed: false,
      broadcast: false,
      source: "Studio Loco public RPC relay",
    };
    const connection = new Connection("https://studioloco.cfd/api/public/rpc/mainnet", {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
    });
    connection.sendRawTransaction = async () => {
      throw new Error("Journey QA cannot broadcast");
    };
    connection.sendTransaction = async () => {
      throw new Error("Journey QA cannot broadcast");
    };
    const pool = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
    const position = "1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id";
    const ctl = new JobControl();
    try {
      const info = await connection.getAccountInfo(new PublicKey(position), "confirmed");
      if (!info) throw new Error("Public position is no longer open.");
      const identity = {
        kind: "position" as const,
        account: position,
        pool,
        owner: new PublicKey(info.data.subarray(40, 72)).toBase58(),
      };
      let job = ctl.begin()!;
      const first = await readJourneySnapshot(connection, identity, job, "relay");
      ctl.end(job);
      job = ctl.begin()!;
      const second = await readJourneySnapshot(connection, identity, job, "relay", first);
      ctl.end(job);
      const j = appendSnapshot(
        appendSnapshot(newJourney(identity, "Public QA position"), first),
        second,
      );
      expect(j.snapshots).toHaveLength(2);
      expect(second.slot).toBeGreaterThanOrEqual(first.checkedSlot);
      report.position = { identity, first, second };
      console.log(
        JSON.stringify({
          stage: "live-position",
          identity,
          firstSlot: first.slot,
          checkedSlot: second.checkedSlot,
        }),
      );
      const orders = await connection.getProgramAccounts(
        new PublicKey(sdk.LBCLMM_PROGRAM_IDS["mainnet-beta"]),
        {
          commitment: "confirmed",
          filters: [sdk.limitOrderFilter(), sdk.limitOrderLbPairFilter(new PublicKey(pool))],
          dataSlice: { offset: 0, length: 72 },
        },
      );
      report.nativeOrderAccountsFound = orders.length;
      if (!orders.length)
        throw new Error("No public native order accounts currently exist in the QA pool.");
      const nativePool = await (sdk.default ?? sdk).create(connection, new PublicKey(pool), {
        cluster: "mainnet-beta",
      });
      let chosen = orders[0]!;
      for (let offset = 0; offset < Math.min(orders.length, 60); offset += 10) {
        const candidates = orders.slice(offset, offset + 10);
        const infos = await connection.getMultipleAccountsInfo(
          candidates.map((c) => c.pubkey),
          "confirmed",
        );
        const populated = infos.findIndex((info) => {
          if (!info) return false;
          const state = nativePool.program.coder.accounts.decode("limitOrder", info.data);
          for (let index = 0; index < state.binCount; index++) {
            const start = 8 + sdk.LIMIT_ORDER_MIN_SIZE + index * sdk.LIMIT_ORDER_BIN_DATA_SIZE;
            const level = nativePool.program.coder.types.decode(
              "limitOrderBinData",
              info.data.subarray(start, start + sdk.LIMIT_ORDER_BIN_DATA_SIZE),
            );
            if (level.age !== 0 || !level.amount.isZero()) return true;
          }
          return false;
        });
        if (populated >= 0) {
          chosen = candidates[populated]!;
          break;
        }
      }
      const orderIdentity = {
        kind: "order" as const,
        account: chosen.pubkey.toBase58(),
        pool,
        owner: new PublicKey(chosen.account.data.subarray(40, 72)).toBase58(),
      };
      job = ctl.begin()!;
      const orderSnapshot = await readJourneySnapshot(connection, orderIdentity, job, "relay");
      ctl.end(job);
      expect(orderSnapshot.kind).toBe("order");
      expect(orderSnapshot.kind === "order" && orderSnapshot.levels.length).toBeGreaterThan(0);
      report.order = { identity: orderIdentity, snapshot: orderSnapshot };
      // The product relay deliberately does not expose signature discovery. Public QA history
      // uses the provider directly; this does not broaden the relay's allowlist.
      const history = new Connection("https://solana-rpc.publicnode.com", {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
      });
      const signatures = await history.getSignaturesForAddress(
        chosen.pubkey,
        { limit: 10 },
        "confirmed",
      );
      const discriminator = new Uint8Array(
        sdk.IDL.instructions.find((i: { name: string }) => i.name === "place_limit_order")
          .discriminator,
      );
      const proofAttempts: { signature: string; error: string }[] = [];
      for (const sig of signatures) {
        if (sig.err) continue;
        const t = await connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        try {
          const proof = transactionProof(t, orderIdentity, discriminator);
          report.nativeInstructionProof = { signature: sig.signature, ...proof };
          break;
        } catch (e) {
          proofAttempts.push({
            signature: sig.signature,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      report.proofAttempts = proofAttempts;
      console.log(JSON.stringify({ proofAttempts }));
      if (!report.nativeInstructionProof)
        report.proofCoverage =
          "No eligible direct Foundry-style placement in the newest 10 public signatures. Such history cannot be promoted into a Foundry link.";
      report.result = "passed";
      console.log(
        JSON.stringify({
          stage: "live-native-order",
          identity: orderIdentity,
          slot: orderSnapshot.slot,
          levels: orderSnapshot.kind === "order" ? orderSnapshot.levels.length : 0,
          nativeInstructionProof:
            report.nativeInstructionProof ?? "No placement among newest 10 signatures",
        }),
      );
    } catch (e) {
      report.result = "failed";
      report.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      ctl.unmount();
      mkdirSync(".qa/journey", { recursive: true });
      writeFileSync(".qa/journey/mainnet.json", JSON.stringify(report, null, 2));
    }
  }, 180_000);
});

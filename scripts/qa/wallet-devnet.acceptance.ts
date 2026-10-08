import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { JobControl } from "@/lib/job-control";
import { createRpcFetch } from "@/lib/rpc-fetch";
import { GENESIS, runTransaction, type PendingStore, type PendingTx } from "@/lib/tx";
import { prepareWalletRehearsal, rehearsalStaleReason, MEMO_PROGRAM } from "@/lib/wallet-rehearsal";

/** Explicit devnet-only QA. Never included in the normal unit suite. */
describe("funded devnet memo rehearsal through the shared runner", () => {
  it.skipIf(process.env["LOCO_QA_DEVNET_MEMO"] !== "1")(
    "confirms one memo with no asset transfer and an exact fee delta",
    async () => {
      const c = new Connection("https://api.devnet.solana.com", {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: createRpcFetch(),
      });
      expect(await c.getGenesisHash()).toBe(GENESIS["devnet"]);
      // Only the already-funded, ignored QA key from this conversation is used.
      const saved = JSON.parse(readFileSync(".qa/funded-devnet-wallet.json", "utf8"));
      if (saved.network !== "devnet" || saved.purpose !== "Studio Loco acceptance")
        throw new Error("Not the dedicated devnet QA wallet.");
      const payer = Keypair.fromSecretKey(Uint8Array.from(saved.secretKey));
      const owner = payer.publicKey.toBase58();
      expect(owner).toBe("FpebsUzBXJ9PLAkFi1Kq4wEPHtyRPznh5e5FpdztpZQZ");
      const pendingPath = ".qa/devnet-pending.json";
      const load = (): PendingTx[] =>
        existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, "utf8")) : [];
      const save = (p: PendingTx[]) =>
        writeFileSync(pendingPath, JSON.stringify(p), { mode: 0o600 });
      const store: PendingStore = {
        list: load,
        put: (p) => save([p, ...load().filter((x) => x.signature !== p.signature)]),
        remove: (s) => save(load().filter((x) => x.signature !== s)),
      };
      const control = new JobControl();
      const job = control.begin()!;
      const report: Record<string, unknown> = {
        at: new Date().toISOString(),
        network: "devnet",
        wallet: owner,
        passed: false,
        browserWalletTest: false,
        realMainnetFunds: false,
        signed: false,
        broadcast: false,
      };
      try {
        const review = await prepareWalletRehearsal({
          connection: c,
          owner,
          cluster: "devnet",
          rpcId: "public-devnet",
          job,
        });
        control.end(job);
        const before = await c.getBalance(payer.publicKey, "confirmed");
        report.reviewFeeLamports = review.feeLamports;
        report.units = review.units;
        report.initialBalanceLamports = before;
        const result = await runTransaction({
          connection: c,
          wallet: {
            publicKey: payer.publicKey,
            signTransaction: async (tx) => {
              tx.partialSign(payer);
              report.signed = true;
              return tx;
            },
          },
          tx: review.tx,
          ctx: {
            cluster: "devnet",
            rpc: "public",
            store,
            maxFeeLamports: review.feeLamports,
            semanticGuard: () =>
              rehearsalStaleReason(
                review,
                {
                  owner,
                  cluster: "devnet",
                  rpcId: "public-devnet",
                  gen: control.gen,
                  practice: false,
                },
                Date.now(),
              ),
          },
          label: "Studio Loco devnet memo acceptance",
          onPhase: (phase, info) => {
            report.phase = phase;
            if (info?.signature) report.signature = info.signature;
            if (phase === "sending") report.broadcast = true;
          },
        });
        const landed = await c.getTransaction(result.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        expect(landed?.meta?.err).toBeNull();
        expect(landed?.meta?.fee).toBe(review.feeLamports);
        if (!landed?.meta) throw new Error("Confirmed transaction metadata is unavailable.");
        const message = landed.transaction.message;
        const keys = message.getAccountKeys().staticAccountKeys;
        expect(keys.map((k) => k.toBase58())).toEqual([owner, MEMO_PROGRAM]);
        expect(landed.meta.preBalances[0]! - landed.meta.postBalances[0]!).toBe(review.feeLamports);
        report.signature = result.signature;
        report.slot = result.slot;
        report.confirmed = true;
        report.networkFeeLamports = landed.meta.fee;
        report.finalBalanceLamports = await c.getBalance(payer.publicKey, "confirmed");
        report.accountKeys = keys.map((k) => k.toBase58());
        report.memoOnly = true;
        report.pending = store.list().length;
        report.passed = true;
        expect(store.list()).toHaveLength(0);
        console.log(
          JSON.stringify({
            passed: true,
            signature: result.signature,
            slot: result.slot,
            feeLamports: landed.meta.fee,
            network: "devnet",
            browserWalletTest: false,
          }),
        );
      } finally {
        control.end(job);
        writeFileSync(
          "docs/qa/wallet-devnet-acceptance.json",
          JSON.stringify(report, null, 2) + "\n",
        );
      }
    },
  );
});

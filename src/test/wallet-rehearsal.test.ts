// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { JobControl } from "@/lib/job-control";
import { GENESIS } from "@/lib/tx";
import {
  MEMO_PROGRAM,
  prepareWalletRehearsal,
  rehearsalStaleReason,
  REHEARSAL_MEMO,
} from "@/lib/wallet-rehearsal";

const owner = Keypair.generate().publicKey.toBase58();
function rpc(o: { genesis?: string; fee?: number | null; balance?: number; err?: unknown } = {}) {
  return {
    getGenesisHash: vi.fn().mockResolvedValue(o.genesis ?? GENESIS["devnet"]),
    getAccountInfo: vi.fn().mockResolvedValue({ executable: true }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: owner, lastValidBlockHeight: 50 }),
    getFeeForMessage: vi.fn().mockResolvedValue({ value: o.fee === undefined ? 5000 : o.fee }),
    getBalance: vi.fn().mockResolvedValue(o.balance ?? 10000),
    simulateTransaction: vi
      .fn()
      .mockResolvedValue({ value: { err: o.err ?? null, unitsConsumed: 14000 } }),
    sendRawTransaction: vi.fn(),
  };
}
async function prepare(c = rpc(), cluster = "devnet") {
  const ctl = new JobControl();
  const job = ctl.begin()!;
  try {
    return await prepareWalletRehearsal({
      connection: c as unknown as Connection,
      owner,
      cluster,
      rpcId: "relay",
      job,
    });
  } finally {
    ctl.end(job);
  }
}
describe("devnet wallet rehearsal", () => {
  it("prepares only the official memo and an exact fee review, without transfer or broadcast", async () => {
    const c = rpc();
    const before = Date.now();
    const r = await prepare(c);
    expect(r.tx.instructions).toHaveLength(1);
    expect(r.tx.instructions[0]?.programId.toBase58()).toBe(MEMO_PROGRAM);
    expect(r.tx.instructions[0]?.data.toString()).toBe(REHEARSAL_MEMO);
    expect(r.tx.instructions[0]?.keys).toEqual([]);
    expect(r.builtAt).toBeGreaterThanOrEqual(before);
    expect(r.feeLamports).toBe(5000);
    expect(c.simulateTransaction).toHaveBeenCalledWith(expect.anything(), {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
    });
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses mainnet before RPC and mismatched devnet genesis before preparing", async () => {
    const mainnet = rpc();
    await expect(prepare(mainnet, "mainnet-beta")).rejects.toThrow(/devnet only/);
    expect(mainnet.getGenesisHash).not.toHaveBeenCalled();
    const wrong = rpc({ genesis: GENESIS["mainnet-beta"] });
    await expect(prepare(wrong)).rejects.toThrow(/does not match/);
    expect(wrong.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it("blocks unknown fees, inadequate balance and failed simulation before approval", async () => {
    await expect(prepare(rpc({ fee: null }))).rejects.toThrow(/fee is unknown/);
    await expect(prepare(rpc({ balance: 4000 }))).rejects.toThrow(/below the rehearsal fee/);
    await expect(prepare(rpc({ err: { InstructionError: [0, "Custom"] } }))).rejects.toThrow(
      /simulation failed/,
    );
  });
  it("expires at preparation time and refuses settings changes including away-and-back generations", async () => {
    const review = await prepare();
    const live = { owner, cluster: "devnet", rpcId: "relay", gen: review.gen, practice: false };
    expect(rehearsalStaleReason(review, live, review.builtAt + 19000)).toBeNull();
    expect(rehearsalStaleReason(review, live, review.builtAt + 20001)).toMatch(/expired/);
    expect(rehearsalStaleReason(review, { ...live, gen: live.gen + 2 }, review.builtAt)).toMatch(
      /changed/,
    );
    expect(rehearsalStaleReason(review, { ...live, practice: true }, review.builtAt)).toMatch(
      /Practice/,
    );
  });
});

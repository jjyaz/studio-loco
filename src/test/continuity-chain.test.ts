import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Buffer } from "buffer";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type Connection,
} from "@solana/web3.js";
import { verifyChapter } from "@/lib/continuity-chain";
import { JobControl } from "@/lib/job-control";
import { DLMM_PROGRAM } from "@/lib/foundry";
import { identity, position, mintX } from "./journey-fixtures";
const mock = vi.hoisted(() => ({ sdk: null as unknown, snapshot: vi.fn(), genesis: vi.fn() }));
vi.mock("@/lib/dlmm", () => ({ loadSdk: async () => mock.sdk }));
vi.mock("@/lib/tx", () => ({ assertCluster: (...args: unknown[]) => mock.genesis(...args) }));
vi.mock("@/lib/journey-chain", () => ({
  readJourneySnapshot: (...args: unknown[]) => mock.snapshot(...args),
}));
const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm");
beforeEach(() => {
  mock.sdk = sdk;
  mock.genesis.mockReset().mockResolvedValue(undefined);
  mock.snapshot.mockReset().mockResolvedValue({ ...position, slot: 201, checkedSlot: 202 });
});
function connection(name: string, present: boolean) {
  const spec = sdk.IDL.instructions.find((i: { name: string }) => i.name === name);
  const pk = (s: string) => new PublicKey(s);
  const ix = new TransactionInstruction({
    programId: pk(DLMM_PROGRAM),
    data: Buffer.from(spec.discriminator),
    keys: spec.accounts.map((a: { name: string; signer?: boolean; writable?: boolean }) => ({
      pubkey: pk(
        a.name === "position"
          ? identity.account
          : a.name === "lb_pair"
            ? identity.pool
            : a.name === "sender" || a.name === "owner"
              ? identity.owner
              : mintX,
      ),
      isSigner: !!a.signer,
      isWritable: !!a.writable,
    })),
  });
  const message = new TransactionMessage({
    payerKey: pk(identity.owner),
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [ix],
  }).compileToV0Message();
  return {
    getTransaction: vi
      .fn()
      .mockResolvedValue({
        slot: 200,
        transaction: { message, signatures: [] },
        meta: { err: null, fee: 5000, loadedAddresses: { writable: [], readonly: [] } },
      }),
    getAccountInfoAndContext: vi
      .fn()
      .mockResolvedValue({ context: { slot: 201 }, value: present ? {} : null }),
  } as unknown as Connection;
}
async function verify(
  name: string,
  present: boolean,
  action: "withdraw" | "close" = "withdraw",
  previous = position,
  history = [previous],
) {
  const ctl = new JobControl(),
    job = ctl.begin()!;
  try {
    return await verifyChapter(
      connection(name, present),
      {
        ...identity,
        action,
        signature: "5".repeat(88),
        step: 0,
        recordId: "tx-verified-action",
        planId: null,
        reviewId: null,
        alertId: null,
      },
      "position",
      previous,
      job,
      "relay",
      history,
    );
  } finally {
    ctl.end(job);
  }
}
describe("Continuity independent post-state evidence", () => {
  it("does not label a corroboration after the action as before", async () => {
    const result = await verify("remove_liquidity2", true, "withdraw", {
      ...position,
      checkedSlot: 201,
    });
    expect(result.chapter.before).toBeNull();
    expect(result.chapter.after!.checkedSlot).toBe(202);
  });
  it("selects an actually prior retained observation instead of the newer poll", async () => {
    const newer = { ...position, slot: 201, checkedSlot: 202 };
    const result = await verify("remove_liquidity2", true, "withdraw", newer, [position, newer]);
    expect(result.chapter.before!.checkedSlot).toBe(101);
  });
  it("retains an earlier successful known-member action with an unavailable post-state, without inferring closure", async () => {
    const result = await verify("remove_liquidity2", false);
    expect(result.chapter.accountAfter).toBe("unavailable");
    expect(result.chapter.after).toBeNull();
  });
  it("requires an independent absent read for a target-bound closure", async () => {
    expect((await verify("close_position2", false, "close")).chapter.accountAfter).toBe("closed");
    await expect(verify("close_position2", true, "close")).rejects.toThrow("no independent read");
  });
});

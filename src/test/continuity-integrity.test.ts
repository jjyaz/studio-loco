import { describe, expect, it } from "vitest";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { createRequire } from "node:module";
import { Buffer } from "buffer";
import { chapterProof, type InstructionSpec } from "@/lib/continuity-proof";
import { DLMM_PROGRAM } from "@/lib/foundry";
import { Chapter, StrategySchema } from "@/lib/continuity";
import {
  applyChapter,
  chapterId,
  exportContinuity,
  migrateJourney,
  parseContinuityImport,
  stageStatus,
  strategyCosts,
  summarize,
} from "@/lib/continuity";
import { identity, journey, position, mintX, mintY } from "./journey-fixtures";
const require = createRequire(import.meta.url);
const sdk = require("@meteora-ag/dlmm");
const specs: Record<string, InstructionSpec> = Object.fromEntries(
  sdk.IDL.instructions.map((i: { name: string } & InstructionSpec) => [i.name, i]),
);
const pk = (s: string) => new PublicKey(s);
const other = mintX,
  destination = mintY;
export function linkedJourney() {
  const j = journey();
  return {
    ...j,
    updatedAt: 11000,
    snapshots: [position],
    links: [
      {
        recordId: "tx-origin-record",
        signature: "4".repeat(88),
        slot: 100,
        blueprintId: "bp-test-origin",
        revision: 1,
        digest: "a".repeat(64),
        name: "Test origin",
        action: "liquidity" as const,
        feeLamports: "5000",
      },
    ],
  };
}
export function strategy() {
  return migrateJourney(linkedJourney())!;
}
function ix(name: string, target = identity.account, pool = identity.pool, owner = identity.owner) {
  const spec = specs[name]!;
  return new TransactionInstruction({
    programId: pk(DLMM_PROGRAM),
    data: Buffer.from(spec.discriminator),
    keys: spec.accounts.map((a) => ({
      pubkey: pk(
        a.name === "position" || a.name === "limit_order"
          ? target
          : a.name === "lb_pair"
            ? pool
            : a.name === "sender" || a.name === "owner"
              ? owner
              : other,
      ),
      isSigner: !!a.signer,
      isWritable: !!a.writable,
    })),
  });
}
function tx(
  instructions: TransactionInstruction[],
  feePayer = identity.owner,
): VersionedTransactionResponse {
  const message = new TransactionMessage({
    payerKey: pk(feePayer),
    recentBlockhash: "11111111111111111111111111111111",
    instructions,
  }).compileToV0Message();
  return {
    slot: 200,
    transaction: { message, signatures: [] },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as unknown as VersionedTransactionResponse;
}
function proof(
  t: VersionedTransactionResponse,
  action: "withdraw" | "close" | "rebalance" | "deposit" = "withdraw",
  priorIdentityVerified = true,
) {
  return chapterProof(t, { ...identity, action, priorIdentityVerified }, specs);
}
export function chapter(
  action: "withdraw" | "deposit" | "claim" | "close" = "claim",
  signature = "5".repeat(88),
  account = identity.account,
  pool = identity.pool,
) {
  return Chapter.parse({
    id: chapterId(signature, 0, account),
    action,
    account,
    pool,
    signature,
    step: 0,
    slot: 200,
    verifiedAt: 12000,
    instructions: [
      action === "withdraw"
        ? "remove_liquidity2"
        : action === "deposit"
          ? "add_liquidity_by_strategy2"
          : action === "close"
            ? "close_position2"
            : "claim_fee2",
    ],
    feeLamports: "5000",
    recordId: "tx-test-action",
    planId: action === "withdraw" || action === "deposit" ? "plan-test-move" : null,
    reviewId: null,
    alertId: null,
    before: summarize(position),
    after: summarize({ ...position, slot: 201, checkedSlot: 202 }),
    accountAfter: "present",
  });
}
describe("Exact native instruction evidence", () => {
  it.each(["remove_liquidity", "remove_liquidity2", "remove_liquidity_by_range2"])(
    "accepts the installed IDL roles for %s",
    (name) => expect(proof(tx([ix(name)])).slot).toBe(200),
  );
  it("refuses a writable target merely appended as an unrelated remaining account", () => {
    const instruction = ix("remove_liquidity2", other);
    instruction.keys.push({ pubkey: pk(identity.account), isWritable: true, isSigner: false });
    expect(() => proof(tx([instruction]))).toThrow("account roles");
  });
  it("refuses the wrong signer, even when the expected owner pays the network fee", () =>
    expect(() =>
      proof(tx([ix("remove_liquidity2", identity.account, identity.pool, destination)])),
    ).toThrow("account roles"));
  it("refuses a pool appearing in the transaction in the wrong role", () => {
    const instruction = ix("remove_liquidity2", identity.account, other);
    instruction.keys.push({ pubkey: pk(identity.pool), isWritable: true, isSigner: false });
    expect(() => proof(tx([instruction]))).toThrow("account roles");
  });
  it("does not close the source when a different target is closed beside its withdrawal", () => {
    const t = tx([ix("remove_liquidity2"), ix("close_position2", other)]);
    expect(proof(t).closing).toBe(false);
    expect(() => proof(t, "close")).toThrow("closing instruction");
  });
  it.each(["close_position2", "close_position_if_empty", "close_limit_order_if_empty"])(
    "accepts %s without a pool slot only with previously checked identity",
    (name) => {
      const t = tx([ix(name)]);
      expect(proof(t, "close").closing).toBe(true);
      expect(() => proof(t, "close", false)).toThrow("account roles");
    },
  );
  it("refuses failed metadata and other programs", () => {
    const t = tx([ix("remove_liquidity2")]);
    t.meta!.err = { InstructionError: [0, "Custom"] } as never;
    expect(() => proof(t)).toThrow("Successful");
    const instruction = ix("remove_liquidity2");
    instruction.programId = pk(other);
    expect(() => proof(tx([instruction]))).toThrow("account roles");
  });
  it("does not charge a sponsored fee to the position owner", () =>
    expect(proof(tx([ix("remove_liquidity2")], destination)).feeLamports).toBe("0"));
});
describe("Continuity ancestry, retention and transfer", () => {
  it("retains the independently checked origin receipt and fee", () => {
    const s = strategy();
    expect(s.chapters).toHaveLength(1);
    expect(strategyCosts(s).lamports).toBe("5000");
  });
  it("is idempotent and uses complete signature/account identities", () => {
    const s = strategy(),
      ch = chapter();
    const next = applyChapter(s, ch, { owner: identity.owner, kind: "position" });
    expect(applyChapter(next, ch, { owner: identity.owner, kind: "position" })).toBe(next);
    expect(chapterId("5".repeat(88), 0, identity.account)).not.toBe(
      chapterId("5".repeat(87) + "6", 0, identity.account),
    );
  });
  it("ordinary withdrawals with a proposal ID do not create a pool move", () =>
    expect(
      applyChapter(strategy(), chapter("withdraw"), { owner: identity.owner, kind: "position" })
        .stages,
    ).toEqual([]));
  it("requires the locally reviewed destination and the same mint pair before linking a new account", () => {
    const a = applyChapter(strategy(), chapter("withdraw"), {
      owner: identity.owner,
      kind: "position",
      move: { id: "plan-test-move", destinationPool: other },
    });
    expect(stageStatus(a.stages[0]!)).toBe("withdrawal-confirmed");
    expect(() =>
      applyChapter(a, chapter("deposit", "6".repeat(88), destination, destination), {
        owner: identity.owner,
        kind: "position",
      }),
    ).toThrow("reviewed pool");
    const deposit = chapter("deposit", "6".repeat(88), destination, other);
    const b = applyChapter(a, deposit, { owner: identity.owner, kind: "position" });
    expect(b.id).toBe(a.id);
    expect(b.accounts[1]!.fromAccount).toBe(identity.account);
    expect(stageStatus(b.stages[0]!)).toBe("complete");
    const wrong = {
      ...deposit,
      after: {
        ...deposit.after!,
        holdings: [{ mint: identity.owner, decimals: 9, raw: "1" }, deposit.after!.holdings[1]!],
        fees: [{ mint: identity.owner, decimals: 9, raw: "1" }, deposit.after!.fees[1]!],
        claimed: [],
      },
    };
    expect(() => applyChapter(a, wrong, { owner: identity.owner, kind: "position" })).toThrow(
      "mint identities",
    );
  });
  it("refuses a destination deposit before the source withdrawal", () => {
    const a = applyChapter(strategy(), chapter("withdraw"), {
      owner: identity.owner,
      kind: "position",
      move: { id: "plan-test-move", destinationPool: other },
    });
    expect(() =>
      applyChapter(
        a,
        { ...chapter("deposit", "6".repeat(88), destination, other), slot: 199 },
        { owner: identity.owner, kind: "position" },
      ),
    ).toThrow("precedes");
  });
  it("pins staged and closing receipts when older chapters are retired", () => {
    let s = applyChapter(strategy(), chapter("withdraw"), {
      owner: identity.owner,
      kind: "position",
      move: { id: "plan-test-move", destinationPool: other },
    });
    const pinned = s.stages[0]!.withdrawal;
    const claims = Array.from({ length: 198 }, (_, i) => {
      const step = i + 1;
      return {
        ...chapter(),
        step,
        id: chapterId("5".repeat(88), step, identity.account),
        slot: 200 + step,
      };
    });
    s = StrategySchema.parse({ ...s, chapters: [...s.chapters, ...claims] });
    const last = {
      ...chapter(),
      step: 199,
      id: chapterId("5".repeat(88), 199, identity.account),
      slot: 399,
    };
    s = applyChapter(s, last, { owner: identity.owner, kind: "position" });
    expect(s.chapters).toHaveLength(200);
    expect(s.chapters.some((ch) => ch.id === pinned)).toBe(true);
    expect(s.omittedChapters).toBe(1);
  });
  it("strictly rejects broken stage relations, duplicates and secret fields", () => {
    const s = strategy();
    expect(
      StrategySchema.safeParse({ ...s, accounts: [...s.accounts, s.accounts[0]] }).success,
    ).toBe(false);
    expect(StrategySchema.safeParse({ ...s, secret: "never accepted" }).success).toBe(false);
    expect(
      StrategySchema.safeParse({
        ...s,
        stages: [
          {
            planId: "p",
            sourceAccount: identity.account,
            sourcePool: identity.pool,
            destinationAccount: null,
            destinationPool: null,
            withdrawal: "missing",
            deposit: null,
            lastAttempt: "none",
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("imports remain supplied evidence and cannot accept verified chapters", () => {
    const parsed = parseContinuityImport(exportContinuity([strategy()]));
    const imported = parsed.strategies[0]!;
    expect(imported.provenance).toBe("import");
    expect(imported.accounts[0]!.verification).toBe("user-supplied");
    expect(() =>
      applyChapter(imported, chapter(), { owner: identity.owner, kind: "position" }),
    ).toThrow("verified strategies");
  });
  it("rejects duplicate strategies, malformed envelopes and oversized UTF-8 input", () => {
    const s = strategy();
    expect(parseContinuityImport(exportContinuity([s, s])).rejected).toBe(1);
    expect(() =>
      parseContinuityImport({ ...exportContinuity([s]), rpcUrl: "https://private.invalid" }),
    ).toThrow();
    expect(() => parseContinuityImport("☄".repeat(3_400_000))).toThrow("10 MB");
  });
  it("conflicting reported fees are unknown instead of silently selected", () => {
    const s = strategy(),
      a = chapter(),
      b = { ...a, step: 1, id: chapterId(a.signature, 1, a.account), feeLamports: "6000" };
    expect(strategyCosts({ ...s, chapters: [a, b] })).toEqual({
      lamports: "0",
      transactions: 1,
      unknown: 1,
    });
  });
});

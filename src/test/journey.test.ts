import { describe, expect, it } from "vitest";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  appendSnapshot,
  foundryCandidate,
  observationEvents,
  rangeHealth,
  snapshotHealth,
  transactionProof,
} from "@/lib/journey";
import { floorRaw, orderRaw, verifiedNetworkFees } from "@/lib/journey-chain";
import { DLMM_PROGRAM } from "@/lib/foundry";
import { orderBaseline, orderTick, ORDER_OBSERVATION_GAP_MS } from "@/lib/journey-signals";
import { identity, blueprint, journey, position, order, receipt } from "./journey-fixtures";
const disc = new Uint8Array([209, 59, 63, 91, 111, 200, 153, 228]);
function tx(
  options: {
    signer?: boolean;
    writable?: boolean;
    pool?: string;
    program?: string;
    discriminator?: Uint8Array;
    payer?: string;
  } = {},
) {
  const t = new Transaction({
    feePayer: new PublicKey(options.payer ?? identity.owner),
    recentBlockhash: "1".repeat(32),
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(options.program ?? DLMM_PROGRAM),
      data: Buffer.from(options.discriminator ?? disc),
      keys: [
        {
          pubkey: new PublicKey(identity.owner),
          isSigner: options.signer ?? true,
          isWritable: true,
        },
        {
          pubkey: new PublicKey(identity.account),
          isSigner: false,
          isWritable: options.writable ?? true,
        },
        { pubkey: new PublicKey(options.pool ?? identity.pool), isSigner: false, isWritable: true },
      ],
    }),
  );
  return {
    slot: 80,
    meta: { err: null, fee: 5000 },
    transaction: { message: t.compileMessage() },
  } as VersionedTransactionResponse;
}
describe("Journey precision and independent receipt evidence", () => {
  it("keeps large UI order values exact, without floating point", () =>
    expect(orderRaw("9007199254740993.123456789", 9)).toBe("9007199254740993123456789"));
  it("converts scientific SDK UI values exactly", () =>
    expect(orderRaw("9.012e-9", 12)).toBe("9012"));
  it("floors raw pro-rata LP units, including scientific notation", () => {
    expect(floorRaw("9007199254740993.9")).toBe("9007199254740993");
    expect(floorRaw("1.234e2")).toBe("123");
    expect(floorRaw("3e-10")).toBe("0");
  });
  it.each(["-1", "NaN", "Infinity", "1e999", "x"])("refuses malformed amounts %s", (v) =>
    expect(() => floorRaw(v)).toThrow(),
  );
  it("refuses nonzero sub-unit order precision", () =>
    expect(() => orderRaw("0.0000000001", 9)).toThrow("sub-unit"));
  it("requires exact local revision/digest/pool and confirmed step", () => {
    const r = receipt("a".repeat(64));
    expect(foundryCandidate(r, blueprint, "a".repeat(64))).toMatchObject(identity);
    expect(foundryCandidate(r, blueprint, "b".repeat(64))).toBeNull();
    r.steps[0]!.phase = "unknown";
    expect(foundryCandidate(r, blueprint, "a".repeat(64))).toBeNull();
  });
  it.each(["import", "cloud"] as const)(
    "refuses %s claims as automatic Foundry origins",
    (provenance) =>
      expect(
        foundryCandidate({ ...receipt("a".repeat(64)), provenance }, blueprint, "a".repeat(64)),
      ).toBeNull(),
  );
  it("verifies native discriminator and exact signer/account/pool binding", () =>
    expect(transactionProof(tx(), identity, disc)).toEqual({ slot: 80, feeLamports: "5000" }));
  it("refuses unrelated native instructions", () =>
    expect(() =>
      transactionProof(tx({ discriminator: new Uint8Array(8) }), identity, disc),
    ).toThrow("expected native"));
  it("refuses wrong program, pool and read-only target", () => {
    expect(() => transactionProof(tx({ program: "1".repeat(32) }), identity, disc)).toThrow();
    expect(() => transactionProof(tx({ pool: blueprint.mintX }), identity, disc)).toThrow();
    expect(() => transactionProof(tx({ writable: false }), identity, disc)).toThrow();
  });
  it("refuses missing or failed metadata", () => {
    expect(() => transactionProof(null, identity, disc)).toThrow();
    const t = tx();
    t.meta!.err = { InstructionError: [0, "InvalidAccountData"] };
    expect(() => transactionProof(t, identity, disc)).toThrow();
  });
  it("does not charge a different fee payer's spending to the owner", () =>
    expect(transactionProof(tx({ payer: blueprint.mintX }), identity, disc).feeLamports).toBe("0"));
  it("refuses a nonsigning owner", () =>
    expect(() =>
      transactionProof(tx({ signer: false, payer: blueprint.mintX }), identity, disc),
    ).toThrow("signer"));
});
describe("Journey observed-time semantics", () => {
  it("starts with a baseline, even when the first order already filled", () =>
    expect(
      observationEvents(undefined, {
        ...order,
        levels: [{ ...order.levels[0]!, state: "filled" }],
      }).map((e) => e.kind),
    ).toEqual(["baseline"]));
  it("distinguishes near-edge and out-of-range", () => {
    expect(rangeHealth(position)).toBe("in range");
    expect(rangeHealth({ ...position, activeId: 9 })).toBe("near edge");
    expect(rangeHealth({ ...position, activeId: 11 })).toBe("out of range");
  });
  it("timestamps an observed partial fill as an interval", () => {
    const n = {
      ...order,
      observedAt: 20000,
      slot: 102,
      checkedSlot: 103,
      levels: [
        {
          ...order.levels[0]!,
          state: "partial" as const,
          filledX: "500000000",
          unfilledX: "500000000",
        },
      ],
    };
    const events = observationEvents(order, n);
    expect(events[0]).toMatchObject({ kind: "level", after: 10000, at: 20000 });
    expect(events[0]!.detail).toContain("partial observed");
  });
  it("reports removed levels as withdrawn/reset observed without asserting a cancellation", () =>
    expect(
      observationEvents(order, { ...order, observedAt: 20000, levels: [] })[0]!.detail,
    ).toContain("Cause and exact time unverified"));
  it("rejects slot/time regressions and changed pool identity", () => {
    const j = appendSnapshot(journey(), position);
    expect(() => appendSnapshot(j, { ...position, observedAt: 20000, slot: 99 })).toThrow(
      "backwards",
    );
    expect(() =>
      appendSnapshot(j, {
        ...position,
        observedAt: 20000,
        slot: 102,
        checkedSlot: 103,
        mintX: identity.owner,
      }),
    ).toThrow("identity changed");
  });
  it("marks failed and old reads unavailable/stale", () => {
    const j = appendSnapshot(journey(), position);
    expect(snapshotHealth(j, 11000)).toBe("verified");
    expect(snapshotHealth(j, 200000)).toBe("stale");
    expect(snapshotHealth({ ...j, lastError: "closed or missing" }, 11000)).toBe("unavailable");
  });
  it("bounds history with explicit loss counts", () => {
    let j = journey();
    for (let i = 0; i < 55; i++)
      j = appendSnapshot(j, {
        ...position,
        observedAt: 10000 + i,
        slot: 100 + i * 2,
        checkedSlot: 101 + i * 2,
      });
    expect(j.snapshots).toHaveLength(48);
    expect(j.omittedSnapshots).toBe(7);
  });
  it("separates increased claimed counters from holdings and PnL", () =>
    expect(
      observationEvents(position, { ...position, observedAt: 20000, claimedX: "10001" })[0]!.detail,
    ).toContain("Recipient and proceeds are not inferred"));
  it("deduplicates linked network fees by signature", () => {
    const j = journey();
    const link = {
      recordId: "tx-test-test",
      signature: "4".repeat(88),
      slot: 80,
      blueprintId: blueprint.id,
      revision: 1,
      digest: "a".repeat(64),
      name: "test",
      action: "liquidity" as const,
      feeLamports: "5000",
    };
    j.links = [link, { ...link, digest: "b".repeat(64) }];
    expect(verifiedNetworkFees(j)).toBe("5000");
  });
});
describe("Hosted native-order observations", () => {
  const opts = {
    watchId: "watch1",
    revision: 1,
    owner: identity.owner,
    account: identity.account,
    pool: identity.pool,
    lastProposed: {},
  };
  const next = {
    ...order,
    observedAt: 20000,
    slot: 102,
    checkedSlot: 103,
    levels: [
      { ...order.levels[0]!, state: "partial" as const, filledX: "50", unfilledX: "999999950" },
    ],
  };
  it("uses the same interval transition model for hosted fills", () =>
    expect(
      orderTick({ ...opts, snapshot: next, previous: orderBaseline(order) }).alert?.payload[
        "observedAfter"
      ],
    ).toBe(order.observedAt));
  it("never alerts on an initial or reset baseline", () =>
    expect(orderTick({ ...opts, snapshot: next, previous: null }).alert).toBeNull());
  it("does not duplicate a stable fill", () =>
    expect(
      orderTick({
        ...opts,
        snapshot: { ...next, observedAt: 30000, slot: 104, checkedSlot: 105 },
        previous: orderBaseline(next),
      }).alert,
    ).toBeNull());
  it("resets after a long observation gap", () => {
    const out = orderTick({
      ...opts,
      snapshot: { ...next, observedAt: order.observedAt + ORDER_OBSERVATION_GAP_MS + 1 },
      previous: orderBaseline(order),
    });
    expect(out.alert).toBeNull();
    expect(out.summary["baseline"]).toBe(true);
  });
});

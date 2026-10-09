import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blueprintDigest,
  blueprintUnits,
  canonicalBlueprint,
  compileBlueprint,
  draftBlueprint,
  foundryBins,
  foundryCostRefusal,
  foundryReviewReason,
  inspectBlueprint,
  nativeFoundryWeights,
  parseBlueprint,
  protocolAdapters,
} from "@/lib/foundry";
const pool = {
  address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  mintX: "So11111111111111111111111111111111111111112",
  mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  binStep: 10,
};
const blueprint = () => ({ ...draftBlueprint(pool), createdAt: 1000 });
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
describe("Foundry blueprint data boundary", () => {
  it("rejects executable payloads, wrong protocols, ambiguous mint pairs and oversized imports", () => {
    expect(() => parseBlueprint({ ...blueprint(), rpc: "https://malicious.example" })).toThrow();
    expect(() => parseBlueprint({ ...blueprint(), signers: [], instructions: [] })).toThrow();
    expect(() => parseBlueprint({ ...blueprint(), protocol: "meteora-dlmm-pro" })).toThrow();
    expect(() => parseBlueprint({ ...blueprint(), mintY: pool.mintX })).toThrow();
    expect(() => parseBlueprint(" ".repeat(25001))).toThrow(/25 KB/);
  });
  it("requires complete budgets and unique ordered liquidity bins", () => {
    const b = blueprint();
    b.liquidity.budgetX = "1";
    b.liquidity.bins[0]!.xBps = 1;
    expect(() => parseBlueprint(b)).toThrow(/10,000/);
    const d = blueprint();
    d.liquidity.bins[1]!.offset = d.liquidity.bins[0]!.offset;
    expect(() => parseBlueprint(d)).toThrow(/contiguous/);
  });
  it("rejects crossing/duplicate order levels and underfunded integer order allocations", () => {
    const b = blueprint();
    b.ladders = [
      {
        side: "buy",
        budget: "0.000001",
        bins: [
          { offset: -4, weightBps: 5000 },
          { offset: -8, weightBps: 5000 },
        ],
      },
    ];
    expect(() => compileBlueprint(b, { activeBinId: 10, decimalsX: 9, decimalsY: 6 })).toThrow(
      /too small/,
    );
    b.ladders[0]!.bins[1]!.offset = 1;
    expect(() => parseBlueprint(b)).toThrow(/Buy levels/);
    b.ladders[0]!.bins[1]!.offset = -4;
    expect(() => parseBlueprint(b)).toThrow(/unique/);
  });
  it("hashes canonical configuration deterministically and makes revisions distinct", async () => {
    const b = blueprint();
    b.ladders = [
      {
        side: "buy",
        budget: "1",
        bins: [
          { offset: -8, weightBps: 5000 },
          { offset: -4, weightBps: 5000 },
        ],
      },
    ];
    const copy = structuredClone(b);
    copy.ladders[0]!.bins.reverse();
    expect(await blueprintDigest(b)).toBe(await blueprintDigest(copy));
    expect(await blueprintDigest({ ...b, revision: 2 })).not.toBe(await blueprintDigest(b));
    b.ladders[0]!.budget = "0.000003";
    copy.ladders[0]!.budget = "0.000003";
    const state = { activeBinId: 100, decimalsX: 9, decimalsY: 6 };
    expect(compileBlueprint(b, state).ladders).toEqual(compileBlueprint(copy, state).ladders);
    expect(compileBlueprint(b, state).ladders[0]!.bins.map((x) => x.binId)).toEqual([92, 96]);
    expect(canonicalBlueprint(b)).not.toContain("rpc");
    expect(await inspectBlueprint(b)).toMatchObject({
      executable: false,
      independentlyVerified: false,
      readOnly: true,
    });
  });
  it("preserves exact high-precision budgets and prevents u64 overflow or discarded precision", () => {
    expect(blueprintUnits("18446744073709551615", 0)).toBe((1n << 64n) - 1n);
    expect(() => blueprintUnits("18446744073709551616", 0)).toThrow(/u64/);
    expect(() => blueprintUnits("1.0000001", 6)).toThrow(/decimal places/);
    expect(blueprintUnits("0.123456789012345678", 18)).toBe(123456789012345678n);
    const b = blueprint();
    b.liquidity.budgetX = "0.000000013";
    b.liquidity.budgetY = "0.000017";
    const c = compileBlueprint(b, { activeBinId: -100, decimalsX: 9, decimalsY: 6 });
    expect(c.bins.reduce((n, x) => n + BigInt(x.xRaw), 0n)).toBe(13n);
    expect(c.bins.reduce((n, x) => n + BigInt(x.yRaw), 0n)).toBe(17n);
    expect(c.bins.filter((x) => x.offset < 0).every((x) => x.xRaw === "0")).toBe(true);
  });
  it("keeps every supported preset on its correct token side and fully allocated", () => {
    for (const r of [1, 10, 34])
      for (const curve of ["uniform", "curve", "bid-ask"] as const) {
        const bins = foundryBins(r, curve);
        expect(bins.length).toBe(r * 2 + 1);
        expect(bins.reduce((n, b) => n + b.xBps, 0)).toBe(10000);
        expect(bins.reduce((n, b) => n + b.yBps, 0)).toBe(10000);
        expect(
          bins.every((b) => (b.offset < 0 ? b.xBps === 0 : b.offset > 0 ? b.yBps === 0 : true)),
        ).toBe(true);
      }
  });
  it("never advertises or compiles Pro as an executable adapter", () => {
    expect(protocolAdapters().adapters[1]).toMatchObject({
      status: "unverified",
      program: null,
      operations: [],
    });
  });
});
describe("Foundry native review guards", () => {
  const identity = {
    wallet: pool.mintX,
    cluster: "mainnet-beta",
    rpc: "relay",
    practice: false,
    digest: "a".repeat(64),
    action: "liquidity",
    position: "",
  };
  const review = { identity, epoch: 3, preparedAt: 10000 };
  it("refuses expiry, clock reversal, practice and ABA identity changes", () => {
    expect(foundryReviewReason(review, identity, 3, 11000)).toBeNull();
    expect(foundryReviewReason(review, identity, 3, 30001)).toMatch(/expired/);
    expect(foundryReviewReason(review, identity, 3, 9999)).toMatch(/expired/);
    expect(foundryReviewReason(review, identity, 5, 11000)).toMatch(/changed/);
    expect(foundryReviewReason(review, { ...identity, practice: true }, 3, 11000)).toMatch(
      /mainnet/,
    );
    expect(foundryReviewReason(review, { ...identity, digest: "b".repeat(64) }, 3, 11000)).toMatch(
      /changed/,
    );
  });
  it("requires known affordable costs, exact atomic size and successful simulation", () => {
    const c = {
      remaining: 0,
      sizes: [800],
      simErrors: [null],
      feeLamports: 5000,
      requiredLamports: 10000000,
      walletLamports: 11000000,
      solOutLamports: 9000000,
      perTxFee: [5000],
      units: [50000],
      logs: [[]],
    };
    expect(foundryCostRefusal(c, 5000)).toBeNull();
    expect(foundryCostRefusal({ ...c, remaining: 1 }, 5000)).toMatch(/more than one/);
    expect(foundryCostRefusal({ ...c, requiredLamports: null }, 5000)).toMatch(
      /could not be verified/,
    );
    expect(foundryCostRefusal({ ...c, walletLamports: 9000000 }, 5000)).toMatch(/cannot fund/);
    expect(foundryCostRefusal(c, 4999)).toMatch(/ceiling/);
    expect(foundryCostRefusal({ ...c, sizes: [1233] }, 5000)).toMatch(/size limit/);
    expect(foundryCostRefusal({ ...c, simErrors: ['{"InstructionError":[1,1]}'] }, 5000)).toMatch(
      /refused/,
    );
  });
  it("keeps native weights integer and refuses funded bins lost to quote precision", () => {
    const rows = [
      { binId: 0, xRaw: "2", yRaw: "0" },
      { binId: 1, xRaw: "0", yRaw: "2" },
    ];
    const weights = nativeFoundryWeights(rows, () => 1n << 64n);
    expect(
      weights.every((x) => x.weight > 0 && Number.isInteger(x.weight) && x.weight <= 65535),
    ).toBe(true);
    expect(() => nativeFoundryWeights([{ binId: 0, xRaw: "1", yRaw: "0" }], () => 1n)).toThrow(
      /native price precision/,
    );
    expect(() =>
      nativeFoundryWeights(
        [
          { binId: 0, xRaw: "1", yRaw: "0" },
          { binId: 1, xRaw: "0", yRaw: "999999999" },
        ],
        () => 1n << 64n,
      ),
    ).toThrow(/zero/);
    // Real mainnet program rejects zero deposit weights even in intentionally empty bins.
    expect(
      nativeFoundryWeights([{ binId: -1, xRaw: "0", yRaw: "0" }, ...rows], () => 1n << 64n).map(
        (b) => b.binId,
      ),
    ).toEqual([0, 1]);
  });
});

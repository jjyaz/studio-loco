import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Buffer } from "buffer";
import BN from "bn.js";
import { JobControl } from "@/lib/job-control";
import { readJourneySnapshot } from "@/lib/journey-chain";
import { DLMM_PROGRAM } from "@/lib/foundry";
import { identity, mintX, mintY, position } from "./journey-fixtures";
const mock = vi.hoisted(() => ({ sdk: null as unknown, genesis: vi.fn() }));
vi.mock("@/lib/dlmm", () => ({ loadSdk: async () => mock.sdk }));
vi.mock("@/lib/tx", () => ({ assertCluster: mock.genesis }));
const pk = (key: string) => new PublicKey(key);
const posDisc = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  pairDisc = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
function account(disc: Uint8Array) {
  return {
    executable: false,
    owner: pk(DLMM_PROGRAM),
    lamports: 10_000_000,
    rentEpoch: 0,
    data: Buffer.concat([
      Buffer.from(disc),
      Buffer.from(pk(identity.pool).toBytes()),
      Buffer.from(pk(identity.owner).toBytes()),
      Buffer.alloc(10),
    ]),
  };
}
function mint(key: string, decimals: number) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1_000_000, rentEpoch: 0, data };
}
let rawAccount: ReturnType<typeof account>, rawPair: ReturnType<typeof account>;
let connection: Connection,
  pool: Record<string, unknown>,
  getPosition: ReturnType<typeof vi.fn>,
  getLimitOrder: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mock.genesis.mockReset().mockResolvedValue(undefined);
  rawAccount = account(posDisc);
  rawPair = account(pairDisc);
  const pair = { tokenXMint: pk(mintX), tokenYMint: pk(mintY), binStep: 10, activeId: 0 };
  getPosition = vi.fn().mockResolvedValue({
    publicKey: pk(identity.account),
    positionData: {
      owner: pk(identity.owner),
      feeOwner: pk(identity.owner),
      lowerBinId: -10,
      upperBinId: 10,
      totalXAmount: "1000000000.99",
      totalYAmount: "1000000.1",
      feeX: new BN(10),
      feeY: new BN(20),
      totalClaimedFeeXAmount: new BN(100),
      totalClaimedFeeYAmount: new BN(200),
      positionBinData: [
        {
          binId: 0,
          positionXAmount: "1000000000.99",
          positionYAmount: "1000000.1",
          positionLiquidity: "90071992547409930",
        },
      ],
    },
  });
  getLimitOrder = vi.fn().mockResolvedValue({
    publicKey: pk(identity.account),
    limitOrderData: {
      transferFeeExcludedWithdrawableAmountX: "1.000000001",
      transferFeeExcludedWithdrawableAmountY: "2",
      totalFeeAmountX: "0.000000001",
      totalFeeAmountY: "0.000002",
      totalUnfilledAmountX: "0.5",
      totalUnfilledAmountY: "0",
      totalFilledAmountX: "0.5",
      totalFilledAmountY: "0",
      totalSwappedAmountX: "0",
      totalSwappedAmountY: "2",
      limitOrderBinData: [
        {
          empty: false,
          status: 1,
          binId: 15,
          isAskSide: true,
          depositAmountX: "1",
          depositAmountY: "0",
          unfilledAmountX: "0.5",
          unfilledAmountY: "0",
          filledAmountX: "0.5",
          filledAmountY: "0",
          swappedAmountX: "0",
          swappedAmountY: "2",
        },
      ],
    },
  });
  pool = {
    pubkey: pk(identity.pool),
    program: { programId: pk(DLMM_PROGRAM), coder: { accounts: { decode: () => pair } } },
    lbPair: pair,
    tokenX: { publicKey: pk(mintX), mint: { decimals: 9 } },
    tokenY: { publicKey: pk(mintY), mint: { decimals: 6 } },
    getPosition,
    getLimitOrder,
  };
  mock.sdk = {
    default: { create: vi.fn().mockResolvedValue(pool) },
    getAccountDiscriminator: (name: string) => (name === "lbPair" ? pairDisc : posDisc),
    wrapPosition: () => ({
      lowerBinId: () => new BN(-10),
      feeOwner: () => pk(identity.owner),
      upperBinId: () => new BN(10),
      totalClaimedFeeXAmount: () => new BN(100),
      totalClaimedFeeYAmount: () => new BN(200),
    }),
  };
  connection = {
    getMultipleAccountsInfoAndContext: vi
      .fn()
      .mockResolvedValueOnce({ context: { slot: 100 }, value: [rawPair, rawAccount] })
      .mockResolvedValueOnce({ context: { slot: 101 }, value: [mint(mintX, 9), mint(mintY, 6)] }),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(8_000_000),
    getAccountInfoAndContext: vi
      .fn()
      .mockResolvedValue({ context: { slot: 102 }, value: rawAccount }),
  } as unknown as Connection;
});
async function read(kind: "position" | "order" = "position", previous?: typeof position) {
  const ctl = new JobControl(),
    job = ctl.begin()!;
  try {
    return await readJourneySnapshot(connection, { ...identity, kind }, job, "relay", previous);
  } finally {
    ctl.end(job);
  }
}
describe("Verified Journey account reader", () => {
  it("checks raw identities and corroborates LP values with disclosed slots", async () => {
    const s = await read();
    expect(s).toMatchObject({
      holdingsX: "1000000000",
      holdingsY: "1000000",
      feeX: "10",
      slot: 100,
      checkedSlot: 102,
      source: "relay",
    });
  });
  it("converts native SDK order UI values to exact raw units", async () => {
    const s = await read("order");
    expect(s).toMatchObject({
      kind: "order",
      holdingsX: "1000000001",
      feeY: "2",
      levels: [{ state: "partial", filledX: "500000000", proceedsY: "2000000" }],
    });
  });
  it("refuses absent accounts without treating them as filled or closed", async () => {
    vi.mocked(connection.getMultipleAccountsInfoAndContext)
      .mockReset()
      .mockResolvedValue({ context: { slot: 100 }, value: [rawPair, null] });
    await expect(read()).rejects.toThrow("Filled or closed cannot be inferred");
  });
  it("refuses wrong owner and wrong pool bindings", async () => {
    rawAccount.data[40] = rawAccount.data[40]! ^ 1;
    await expect(read()).rejects.toThrow("owner");
  });
  it("refuses a different account program", async () => {
    rawAccount.owner = TOKEN_PROGRAM_ID;
    await expect(read()).rejects.toThrow("program");
  });
  it("refuses the wrong discriminator before loading the pool", async () => {
    rawAccount.data[0] = 22;
    await expect(read()).rejects.toThrow("type");
  });
  it("refuses pool mint identity mismatches", async () => {
    (pool["tokenX"] as { publicKey: PublicKey }).publicKey = pk(identity.owner);
    await expect(read()).rejects.toThrow("identity");
  });
  it("refuses a processed position belonging to another owner", async () => {
    const pos = await (
      pool["getPosition"] as () => Promise<{ positionData: { owner: PublicKey } }>
    )();
    pos.positionData.owner = pk(mintX);
    await expect(read()).rejects.toThrow("Processed position");
  });
  it("refuses target bytes that change during SDK hydration", async () => {
    vi.mocked(connection.getAccountInfoAndContext).mockResolvedValue({
      context: { slot: 102 },
      value: { ...rawAccount, data: Buffer.concat([rawAccount.data, Buffer.from([1])]) },
    });
    await expect(read()).rejects.toThrow("changed during observation");
  });
  it("requires the previous corroboration slot and refuses a regressed RPC context", async () => {
    await expect(read("position", { ...position, checkedSlot: 110 })).rejects.toThrow(
      "required slot",
    );
    expect(connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ minContextSlot: 110 }),
    );
  });
  it("refuses regressed final corroboration", async () => {
    vi.mocked(connection.getAccountInfoAndContext).mockResolvedValue({
      context: { slot: 99 },
      value: rawAccount,
    });
    await expect(read()).rejects.toThrow("backwards");
  });
  it("cancels a late read when the generation changes", async () => {
    const ctl = new JobControl(),
      job = ctl.begin()!;
    let resolve!: (v: unknown) => void;
    mock.genesis.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p = readJourneySnapshot(connection, identity, job, "relay");
    ctl.invalidate();
    resolve(undefined);
    await expect(p).rejects.toThrow("Cancelled");
    ctl.end(job);
    expect(getPosition).not.toHaveBeenCalled();
  });
});

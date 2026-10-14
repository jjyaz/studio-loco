// @vitest-environment node
import { Buffer } from "buffer";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, MINT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobControl } from "@/lib/job-control";
import { readConductorSnapshot } from "@/lib/conductor-chain";
import { identity, mintX, mintY } from "./journey-fixtures";
const mocks = vi.hoisted(() => ({ sdk: null as any, genesis: vi.fn() }));
vi.mock("@/lib/dlmm", () => ({
  loadSdk: async () => mocks.sdk,
  DLMM_PROGRAM_ID: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
}));
vi.mock("@/lib/tx", () => ({ assertCluster: (...args: unknown[]) => mocks.genesis(...args) }));
const program = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
  poolKey = new PublicKey(identity.pool);
function fixture() {
  const pair = {
    tokenXMint: new PublicKey(mintX),
    tokenYMint: new PublicKey(mintY),
    reserveX: new PublicKey(identity.owner),
    reserveY: poolKey,
    activeId: 0,
    binStep: 10,
    status: 0,
    activationType: 1,
    activationPoint: new BN(0),
    parameters: { collectFeeMode: 0 },
  };
  const derive = (index: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("conductor-fixture"), Buffer.from(index.toString())],
      program,
    );
  const info = (data: Buffer, owner = program, lamports = 1000000000) => ({
    data,
    owner,
    executable: false,
    lamports,
    rentEpoch: 0,
  });
  const discriminator = (name: string) =>
    Buffer.alloc(8, name === "lbPair" ? 1 : name === "binArray" ? 2 : 3);
  const poolInfo = info(discriminator("lbPair"));
  const mint = (decimals: number) => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 1000000000n,
        decimals,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      data,
    );
    return info(data, TOKEN_PROGRAM_ID);
  };
  const mintInfos = [mint(9), mint(6)];
  const clockInfo = info(
    Buffer.alloc(40),
    new PublicKey("Sysvar1111111111111111111111111111111111111"),
  );
  const decode = vi.fn((name: string, data: Buffer) =>
    name === "lbPair" ? pair : { lbPair: poolKey, index: new BN(data[8]! - 4), bins: [] },
  );
  const sdkPool = {
    pubkey: poolKey,
    program: { programId: program, coder: { accounts: { decode } } },
    lbPair: pair,
    binArrayBitmapExtension: null,
    tokenX: {},
    tokenY: {},
    clock: {},
    swapQuote: vi.fn(
      (input: BN, swapForY: boolean, _slippage: BN, arrays: { publicKey: PublicKey }[]) => ({
        consumedInAmount: input,
        outAmount: input.muln(99).divn(100),
        fee: input.muln(8).divn(1000),
        protocolFee: input.muln(2).divn(1000),
        feeOnInput: true,
        binArraysPubkey: [arrays[0]!.publicKey],
      }),
    ),
  };
  mocks.sdk = {
    default: { create: vi.fn(async () => sdkPool) },
    getAccountDiscriminator: discriminator,
    deriveBinArrayBitmapExtension: () => [derive(new BN(100))[0]],
    findNextBinArrayIndexWithLiquidity: (_swapForY: boolean, active: BN) =>
      new BN(Math.floor(active.toNumber() / 70)),
    deriveBinArray: (_pool: PublicKey, index: BN) => derive(index),
    getBinArrayLowerUpperBinId: (index: BN) => [index.muln(70), index.muln(70).addn(69)],
    getQPriceFromId: () => new BN("18446744073709551616"),
    ClockLayout: {
      decode: () => ({
        slot: new BN(100),
        epochStartTimestamp: new BN(0),
        epoch: new BN(1),
        leaderScheduleEpoch: new BN(1),
        unixTimestamp: new BN(Math.floor(Date.now() / 1000)),
      }),
    },
  };
  const quoteReads: PublicKey[][] = [];
  const connection = {
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot: 100 }, value: poolInfo })),
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => {
      if (keys.length === 3)
        return {
          context: { slot: 102 },
          value: [info(Buffer.alloc(0), PublicKey.default), null, null],
        };
      quoteReads.push(keys);
      return {
        context: { slot: 101 },
        value: [
          poolInfo,
          ...mintInfos,
          clockInfo,
          null,
          ...keys.slice(5).map((key) => {
            const index = [-1, 0, 1].find((i) => derive(new BN(i))[0].equals(key))!;
            return info(Buffer.concat([discriminator("binArray"), Buffer.from([index + 4])]));
          }),
        ],
      };
    }),
    sendTransaction: vi.fn(),
    sendRawTransaction: vi.fn(),
  };
  return { connection, pair, sdkPool, poolInfo, mintInfos, clockInfo, quoteReads, decode };
}
const input = {
  pool: identity.pool,
  owner: identity.owner,
  probesX: ["1000000"],
  probesY: ["1000000"],
};
beforeEach(() => {
  mocks.genesis.mockReset().mockResolvedValue(undefined);
});
async function read(f: ReturnType<typeof fixture>, minimumSlot = 0) {
  const ctl = new JobControl(),
    job = ctl.begin()!;
  try {
    return await readConductorSnapshot(
      f.connection as never,
      { ...input, minimumSlot },
      job,
      "relay",
    );
  } finally {
    ctl.end(job);
  }
}
describe("Conductor isolated read adapter", () => {
  it("freezes <=9 quote accounts in one context, then labels separate owner balances", async () => {
    const f = fixture(),
      s = await read(f);
    expect(f.quoteReads).toHaveLength(1);
    expect(f.quoteReads[0]!.length).toBeLessThanOrEqual(9);
    expect(s.slot).toBe(101);
    expect(s.funds!.slot).toBe(102);
    expect(s.funds!.ataXRaw).toBe("0");
    expect(s.position).toBeNull();
    expect(f.sdkPool.swapQuote).toHaveBeenCalledTimes(2);
    expect(
      f.sdkPool.swapQuote.mock.calls.every(
        (call) => call[3] === f.sdkPool.swapQuote.mock.calls[0]![3],
      ),
    ).toBe(true);
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses a wrong program or discriminator before quoting", async () => {
    const f = fixture();
    f.poolInfo.owner = TOKEN_PROGRAM_ID;
    await expect(read(f)).rejects.toThrow(/Unverified lbPair/);
    expect(f.sdkPool.swapQuote).not.toHaveBeenCalled();
    const g = fixture();
    g.poolInfo.data[0] = 99;
    await expect(read(g)).rejects.toThrow(/Unverified lbPair/);
  });
  it("refuses unsupported transfer effects, bad clock ownership and mint initialization", async () => {
    const f = fixture();
    f.mintInfos[0]!.owner = TOKEN_2022_PROGRAM_ID;
    await expect(read(f)).rejects.toThrow(/Token-2022/);
    const g = fixture();
    g.clockInfo.owner = TOKEN_PROGRAM_ID;
    await expect(read(g)).rejects.toThrow(/clock/);
    const h = fixture();
    h.mintInfos[0]!.data[45] = 0;
    await expect(read(h)).rejects.toThrow(/initialization/);
  });
  it("refuses a bin belonging to another pool and a rollback despite RPC minContextSlot", async () => {
    const f = fixture();
    const original = f.decode.getMockImplementation()!;
    f.decode.mockImplementation((name, data) =>
      name === "binArray"
        ? { ...original(name, data), lbPair: new PublicKey(identity.owner) }
        : original(name, data),
    );
    await expect(read(f)).rejects.toThrow(/pool binding/);
    const g = fixture();
    await expect(read(g, 200)).rejects.toThrow(/backwards/);
  });
  it("keeps partial/failed quotes unknown and owner-read failures separate from quotes", async () => {
    const f = fixture();
    const normal = f.sdkPool.swapQuote.getMockImplementation()!;
    f.sdkPool.swapQuote.mockImplementation((...args) => ({
      ...normal(...args),
      consumedInAmount: new BN(1),
    }));
    const s = await read(f);
    expect(s.quotes.every((q) => q.status === "unavailable")).toBe(true);
    const g = fixture(),
      get = g.connection.getMultipleAccountsInfoAndContext.getMockImplementation()!;
    g.connection.getMultipleAccountsInfoAndContext.mockImplementation(async (keys) => {
      if (keys.length === 3) throw new Error("Owner RPC failed");
      return get(keys);
    });
    const t = await read(g);
    expect(t.funds).toBeNull();
    expect(t.fundsError).toMatch(/Owner RPC/);
    expect(t.quotes.every((q) => q.status === "quoted")).toBe(true);
  });
});

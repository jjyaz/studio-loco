// @vitest-environment node
import { Buffer } from "buffer";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  decodeTransferInstruction,
} from "@solana/spl-token";
import { describe, expect, it, vi } from "vitest";
import {
  prepareFoundryToken,
  validateFoundryPool,
  type FoundryPoolSnapshot,
} from "@/lib/foundry-chain";
import { draftBlueprint } from "@/lib/foundry";
import { JobControl } from "@/lib/job-control";
const owner = new PublicKey("6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD");
const other = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
function account(amount: bigint, authority = owner, mint = NATIVE_MINT) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner: authority,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: mint.equals(NATIVE_MINT) ? 1 : 0,
      isNative: 2039280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 2039280 + Number(amount),
    rentEpoch: 0,
  };
}
describe("native funding safety", () => {
  it("consumes existing WSOL first, wraps only the deficit and never closes its account", async () => {
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const connection = { getAccountInfo: vi.fn(async () => account(600n)) };
    const result = await prepareFoundryToken({
      connection: connection as never,
      owner,
      mint: NATIVE_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      amount: 1000n,
      job,
    });
    expect(result.wrappedLamports).toBe(400n);
    expect(result.post).toHaveLength(0);
    expect(result.temporaryRentLamports).toBe(0);
    expect(result.pre).toHaveLength(2);
    expect(result.pre[0]!.programId.equals(SystemProgram.programId)).toBe(true);
    ctl.end(job);
  });
  it("uses strict temporary WSOL creation, counts rent upfront and closes only the new account", async () => {
    const ctl = new JobControl(),
      job = ctl.begin()!;
    const connection = {
      getAccountInfo: vi.fn(async () => null),
      getMinimumBalanceForRentExemption: vi.fn(async () => 2039280),
    };
    const result = await prepareFoundryToken({
      connection: connection as never,
      owner,
      mint: NATIVE_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      amount: 1000n,
      job,
    });
    // Strict ATA create is data-empty; idempotent create would carry byte 1.
    expect(result.pre[0]!.data.length).toBe(0);
    expect(result.temporaryRentLamports).toBe(2039280);
    expect(result.post).toHaveLength(1);
    expect(result.post[0]!.keys[0]!.pubkey.equals(result.address)).toBe(true);
    expect(result.post[0]!.data[0]).toBe(9);
    ctl.end(job);
  });
  it("refuses wrong token authorities, wrong mints and insufficient non-native balances", async () => {
    const ctl = new JobControl();
    let job = ctl.begin()!;
    await expect(
      prepareFoundryToken({
        connection: { getAccountInfo: async () => account(1000n, other) } as never,
        owner,
        mint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        amount: 1n,
        job,
      }),
    ).rejects.toThrow(/valid account/);
    ctl.end(job);
    job = ctl.begin()!;
    await expect(
      prepareFoundryToken({
        connection: { getAccountInfo: async () => account(1000n, owner, other) } as never,
        owner,
        mint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        amount: 1n,
        job,
      }),
    ).rejects.toThrow(/valid account/);
    ctl.end(job);
    job = ctl.begin()!;
    await expect(
      prepareFoundryToken({
        connection: { getAccountInfo: async () => account(1n, owner, other) } as never,
        owner,
        mint: other,
        tokenProgram: TOKEN_PROGRAM_ID,
        amount: 2n,
        job,
      }),
    ).rejects.toThrow(/below/);
    ctl.end(job);
  });
});
describe("pool adapter capability boundary", () => {
  const bp = draftBlueprint({
    address: other.toBase58(),
    mintX: NATIVE_MINT.toBase58(),
    mintY: owner.toBase58(),
    binStep: 10,
  });
  const s = {
    address: bp.pool,
    mintX: bp.mintX,
    mintY: bp.mintY,
    binStep: 10,
    enabled: true,
    activated: true,
    supportedMints: true,
    totalFeeBps: 10,
    limitOrders: true,
    mintNotes: [],
  } as unknown as FoundryPoolSnapshot;
  it("requires exact mints, active pool, supported extensions and known fee/capability limits", () => {
    expect(validateFoundryPool(s, bp, "liquidity")).toBeNull();
    expect(validateFoundryPool({ ...s, mintX: bp.mintY }, bp, "liquidity")).toMatch(/differ/);
    expect(validateFoundryPool({ ...s, activated: false }, bp, "liquidity")).toMatch(/activated/);
    expect(validateFoundryPool({ ...s, totalFeeBps: 101 }, bp, "liquidity")).toMatch(/ceiling/);
    expect(validateFoundryPool({ ...s, limitOrders: false }, bp, "buy")).toMatch(
      /does not support/,
    );
    expect(validateFoundryPool({ ...s, supportedMints: false }, bp, "liquidity")).toMatch(
      /extensions/,
    );
  });
});

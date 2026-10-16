// @vitest-environment node
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import BN from "bn.js";
import { Buffer } from "buffer";
import bs58 from "bs58";
import {
  inspectMissionInstructions,
  canonicalAta,
  SPL,
  executionHash,
  verifiedOperationSpend,
  type ExecutionBinding,
} from "@/lib/conductor-execution-proof";
import { DLMM_PROGRAM } from "@/lib/foundry";
import type { InstructionSpec } from "@/lib/continuity-proof";
import { missionScope } from "./conductor-fixtures";
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm");
const coder = new BorshInstructionCoder(sdk.IDL as Idl);
const specs: Record<string, InstructionSpec> = Object.fromEntries(
  sdk.IDL.instructions.map((i: { name: string }) => [i.name, i]),
);
const key = () => Keypair.generate().publicKey.toBase58();
function fixture(action: ExecutionBinding["action"] = "claim") {
  const owner = Keypair.generate(),
    position = key(),
    pool = missionScope.pool;
  const binding: ExecutionBinding = {
    scope: {
      ...missionScope,
      owner: owner.publicKey.toBase58(),
      position,
      journeyId: "journey-proof-0001",
    },
    action,
    reserveX: key(),
    reserveY: key(),
    binArrays: [
      sdk.deriveBinArray(new PublicKey(pool), new BN(0), new PublicKey(DLMM_PROGRAM))[0].toBase58(),
    ],
    bitmap: sdk
      .deriveBinArrayBitmapExtension(new PublicKey(pool), new PublicKey(DLMM_PROGRAM))[0]
      .toBase58(),
    eventAuthority: PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      new PublicKey(DLMM_PROGRAM),
    )[0].toBase58(),
    source: { lower: 0, upper: 20 },
    target: { lower: 1, upper: 21 },
    activeId: 10,
    bps: 2500,
    maxActiveBinSlippage: 12,
  };
  const roles: Record<string, string> = {
    lb_pair: pool,
    position,
    sender: binding.scope.owner,
    owner: binding.scope.owner,
    rent_payer: binding.scope.owner,
    reserve_x: binding.reserveX,
    reserve_y: binding.reserveY,
    user_token_x: canonicalAta(binding.scope.mintX, binding.scope.owner),
    user_token_y: canonicalAta(binding.scope.mintY, binding.scope.owner),
    token_x_mint: binding.scope.mintX,
    token_y_mint: binding.scope.mintY,
    token_program_x: SPL,
    token_program_y: SPL,
    token_x_program: SPL,
    token_y_program: SPL,
    memo_program: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    event_authority: binding.eventAuthority,
    program: DLMM_PROGRAM,
    bin_array_bitmap_extension: DLMM_PROGRAM,
    system_program: SystemProgram.programId.toBase58(),
  };
  const ix = (name: string, args: Record<string, unknown>) =>
    new TransactionInstruction({
      programId: new PublicKey(DLMM_PROGRAM),
      data: coder.encode(name, args),
      keys: sdk.IDL.instructions
        .find((i: { name: string }) => i.name === name)
        .accounts.map((a: { name: string; signer?: boolean; writable?: boolean }) => ({
          pubkey: new PublicKey(roles[a.name]!),
          isSigner: !!a.signer,
          isWritable: !!a.writable,
        })),
    });
  const tx = (...instructions: TransactionInstruction[]) =>
    new Transaction({ feePayer: owner.publicKey, recentBlockhash: key() }).add(...instructions);
  const claim = () =>
    ix("claim_fee2", { min_bin_id: 0, max_bin_id: 20, remaining_accounts_info: { slices: [] } });
  const inspect = (t: Transaction) =>
    inspectMissionInstructions(t, binding, specs, (d) => coder.decode(Buffer.from(d)));
  return { owner, binding, tx, ix, claim, inspect };
}
describe("strict mission instruction verification against the installed native IDL", () => {
  it("accepts a canonical fee claim and rejects a substituted recipient or position", () => {
    const f = fixture();
    expect(f.inspect(f.tx(f.claim())).names).toEqual(["claim_fee2"]);
    for (const name of ["user_token_x", "position", "token_x_mint", "reserve_x"]) {
      const ix = f.claim(),
        spec = sdk.IDL.instructions.find((i: { name: string }) => i.name === "claim_fee2");
      ix.keys[spec.accounts.findIndex((a: { name: string }) => a.name === name)]!.pubkey =
        new PublicKey(key());
      expect(() => f.inspect(f.tx(ix))).toThrow(/role/);
    }
  });
  it("rejects extra transfers, missing/duplicate native actions and wrong fee payers", () => {
    const f = fixture();
    expect(() =>
      f.inspect(
        f.tx(
          f.claim(),
          SystemProgram.transfer({
            fromPubkey: f.owner.publicKey,
            toPubkey: new PublicKey(key()),
            lamports: 1,
          }),
        ),
      ),
    ).toThrow(/Unsupported program/);
    expect(() => f.inspect(f.tx(f.claim(), f.claim()))).toThrow(/Exactly one/);
    const t = f.tx(f.claim());
    t.feePayer = new PublicKey(key());
    expect(() => f.inspect(t)).toThrow(/fee payer/);
  });
  it("binds the exact withdrawal range and reviewed percentage", () => {
    const f = fixture("withdraw");
    const make = (bps = 2500) =>
      f.ix("remove_liquidity_by_range2", {
        from_bin_id: 0,
        to_bin_id: 20,
        bps_to_remove: bps,
        remaining_accounts_info: { slices: [] },
      });
    expect(f.inspect(f.tx(make())).names).toContain("remove_liquidity_by_range2");
    expect(() => f.inspect(f.tx(make(10000)))).toThrow(/percentage/);
    expect(() => f.inspect(f.tx(f.claim()))).toThrow(/outside/);
  });
  it("accepts the SDK's empty standard-SPL hook descriptors and rejects nonempty hooks", () => {
    const f = fixture();
    const make = (length = 0) =>
      f.ix("claim_fee2", {
        min_bin_id: 0,
        max_bin_id: 20,
        remaining_accounts_info: {
          slices: [
            { accounts_type: { TransferHookX: {} }, length },
            { accounts_type: { TransferHookY: {} }, length: 0 },
          ],
        },
      });
    expect(f.inspect(f.tx(make())).names).toContain("claim_fee2");
    expect(() => f.inspect(f.tx(make(1)))).toThrow(/Transfer hooks/);
  });
  it("binds rebalance ranges and refuses a wallet top-up or unverified remaining account", () => {
    const f = fixture("rebalance");
    const make = (topup = 0) =>
      f.ix("rebalance_liquidity", {
        params: {
          active_id: 10,
          max_active_bin_slippage: 12,
          should_claim_fee: true,
          should_claim_reward: true,
          min_withdraw_x_amount: new BN(0),
          min_withdraw_y_amount: new BN(0),
          max_deposit_x_amount: new BN(topup),
          max_deposit_y_amount: new BN(0),
          shrink_mode: 0,
          padding: Array(31).fill(0),
          removes: [{ min_bin_id: 0, max_bin_id: 20, bps: 10000, padding: Array(16).fill(0) }],
          adds: [
            {
              min_delta_id: -9,
              max_delta_id: 11,
              x0: new BN(1),
              y0: new BN(1),
              delta_x: new BN(0),
              delta_y: new BN(0),
              bit_flag: 0,
              favor_x_in_active_id: false,
              padding: Array(16).fill(0),
            },
          ],
        },
        remaining_accounts_info: { slices: [] },
      });
    expect(f.inspect(f.tx(make())).names).toContain("rebalance_liquidity");
    expect(() => f.inspect(f.tx(make(1)))).toThrow(/zero token top-up/);
    const ix = make();
    ix.keys.push({ pubkey: new PublicKey(key()), isSigner: false, isWritable: true });
    expect(() => f.inspect(f.tx(ix))).toThrow(/remaining accounts/);
  });
});

describe("receipt-based operation cost accounting (synthetic receipts, no chain sends)", () => {
  async function receipt(failed = false) {
    const f = fixture(),
      destination = new PublicKey(key());
    const tx = f.tx(
      SystemProgram.transfer({
        fromPubkey: f.owner.publicKey,
        toPubkey: destination,
        lamports: 12345,
      }),
    );
    tx.sign(f.owner);
    const m = tx.compileMessage();
    const t = {
      slot: 100,
      transaction: { message: m, signatures: [bs58.encode(tx.signature!)] },
      meta: {
        fee: 5000,
        err: failed ? { InstructionError: [0, "Custom"] } : null,
        preBalances: [],
        postBalances: [],
        innerInstructions: [],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    } as unknown as VersionedTransactionResponse;
    return {
      t,
      expected: {
        owner: f.owner.publicKey.toBase58(),
        messageHash: await executionHash(m.serialize()),
        mintX: f.binding.scope.mintX,
        mintY: f.binding.scope.mintY,
      },
    };
  }
  it("counts gross funding plus fee and refuses a mismatched signed message", async () => {
    const { t, expected } = await receipt();
    expect((await verifiedOperationSpend(t, expected)).spend.lamports).toBe("17345");
    await expect(
      verifiedOperationSpend(t, { ...expected, messageHash: "a".repeat(64) }),
    ).rejects.toThrow(/message/);
  });
  it("charges only the real fee after a rolled-back on-chain failure", async () => {
    const { t, expected } = await receipt(true);
    expect((await verifiedOperationSpend(t, expected)).spend).toEqual({
      xRaw: "0",
      yRaw: "0",
      lamports: "5000",
    });
  });
});

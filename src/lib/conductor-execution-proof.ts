/** Strict ordinary-DLMM execution surface. No arbitrary token transfers or WSOL closes. */
import type {
  Transaction,
  TransactionInstruction,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { PublicKey, SystemProgram, SystemInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import type { MissionScope } from "./conductor";
import type { Spend } from "../../packages/sdk/src/ledger";
import { flatAccounts, type InstructionSpec } from "./continuity-proof";
import { DLMM_PROGRAM } from "./foundry";

export const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const RENT = "SysvarRent111111111111111111111111111111111";
const address = (k: string) => new PublicKey(k);
export const canonicalAta = (mint: string, owner: string) =>
  PublicKey.findProgramAddressSync(
    [address(owner).toBuffer(), address(SPL).toBuffer(), address(mint).toBuffer()],
    address(ATA),
  )[0].toBase58();
export async function executionHash(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function instructionHash(tx: Transaction) {
  return executionHash(
    new TextEncoder().encode(
      JSON.stringify({
        payer: tx.feePayer?.toBase58() ?? null,
        instructions: tx.instructions.map((ix) => ({
          program: ix.programId.toBase58(),
          data: [...ix.data],
          keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
        })),
      }),
    ),
  );
}
export interface ExecutionBinding {
  scope: MissionScope;
  action: "claim" | "withdraw" | "rebalance";
  reserveX: string;
  reserveY: string;
  binArrays: string[];
  bitmap: string;
  eventAuthority: string;
  source: { lower: number; upper: number };
  target: { lower: number; upper: number } | null;
  activeId: number;
  bps: number;
  maxActiveBinSlippage: number;
}
type Decoded = { name: string; data: unknown } | null;
const normalized = (s: string) => s.replaceAll("_", "").toLowerCase();
function field(o: unknown, key: string): unknown {
  if (!o || typeof o !== "object") throw new Error("Missing decoded instruction fields.");
  const e = Object.entries(o).find(([k]) => normalized(k) === normalized(key));
  return e?.[1];
}
function integer(o: unknown, key: string): number {
  const n = field(o, key);
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`Invalid ${key}.`);
  return n;
}
function raw(o: unknown, key: string) {
  const n = field(o, key);
  const text = typeof n === "object" && n !== null ? String(n) : String(n ?? "");
  if (!/^(0|[1-9]\d{0,19})$/.test(text) || BigInt(text) > 18446744073709551615n)
    throw new Error(`Invalid ${key}.`);
  return BigInt(text);
}
function inRange(o: unknown, lo: string, hi: string, expected: { lower: number; upper: number }) {
  if (integer(o, lo) !== expected.lower || integer(o, hi) !== expected.upper)
    throw new Error("Decoded range differs from the reviewed range.");
}
/** Every instruction and recipient is checked. Unknown programs/roles/remaining accounts refuse. */
export function inspectMissionInstructions(
  tx: Transaction,
  b: ExecutionBinding,
  specs: Record<string, InstructionSpec>,
  decode: (data: Uint8Array) => Decoded,
) {
  if (!b.scope.position || tx.feePayer?.toBase58() !== b.scope.owner)
    throw new Error("Mission position and exact owner fee payer are required.");
  if (!tx.instructions.length || tx.instructions.length > 16)
    throw new Error("Unsupported instruction count.");
  const userX = canonicalAta(b.scope.mintX, b.scope.owner),
    userY = canonicalAta(b.scope.mintY, b.scope.owner);
  const roles: Record<string, string | string[]> = {
    position: b.scope.position,
    lb_pair: b.scope.pool,
    owner: b.scope.owner,
    sender: b.scope.owner,
    rent_payer: b.scope.owner,
    funder: b.scope.owner,
    user_token_x: userX,
    user_token_y: userY,
    reserve_x: b.reserveX,
    reserve_y: b.reserveY,
    token_x_mint: b.scope.mintX,
    token_y_mint: b.scope.mintY,
    token_program: SPL,
    token_program_x: SPL,
    token_program_y: SPL,
    token_x_program: SPL,
    token_y_program: SPL,
    system_program: SystemProgram.programId.toBase58(),
    rent: RENT,
    memo_program: MEMO,
    event_authority: b.eventAuthority,
    program: DLMM_PROGRAM,
    // Installed rebalance SDK uses the default key for an absent bitmap; other builders use the program sentinel.
    bin_array_bitmap_extension: [
      b.bitmap,
      DLMM_PROGRAM,
      ...(b.action === "rebalance" ? [SystemProgram.programId.toBase58()] : []),
    ],
    bin_array: b.binArrays,
    bin_array_lower: b.binArrays,
    bin_array_upper: b.binArrays,
  };
  let main = 0;
  const names: string[] = [],
    computeTags = new Set<number>();
  for (const ix of tx.instructions) {
    if (ix.keys.some((k) => k.isSigner && k.pubkey.toBase58() !== b.scope.owner))
      throw new Error("Unexpected signer.");
    const program = ix.programId.toBase58();
    if (program === COMPUTE) {
      const tag = ix.data[0]!;
      if (
        ix.keys.length ||
        ![2, 3].includes(tag) ||
        computeTags.has(tag) ||
        ix.data.length !== (tag === 2 ? 5 : 9)
      )
        throw new Error("Unsupported compute-budget instruction.");
      if (tag === 2 && (ix.data.readUInt32LE(1) < 1 || ix.data.readUInt32LE(1) > 1_400_000))
        throw new Error("Invalid compute-unit limit.");
      computeTags.add(tag);
      names.push(tag === 2 ? "compute-unit-limit" : "compute-unit-price");
      continue;
    }
    if (program === ATA) {
      if (
        !(ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1)) ||
        ![6, 7].includes(ix.keys.length)
      )
        throw new Error("Unsupported associated-token instruction.");
      const keys = ix.keys.map((k) => k.pubkey.toBase58());
      if (
        keys[0] !== b.scope.owner ||
        keys[2] !== b.scope.owner ||
        keys[4] !== SystemProgram.programId.toBase58() ||
        keys[5] !== SPL ||
        ![b.scope.mintX, b.scope.mintY].includes(keys[3]!) ||
        keys[1] !== canonicalAta(keys[3]!, b.scope.owner) ||
        (keys.length === 7 && keys[6] !== RENT) ||
        !ix.keys[0]!.isSigner ||
        !ix.keys[0]!.isWritable ||
        !ix.keys[1]!.isWritable
      )
        throw new Error(
          "Token account creation has an unexpected owner, payer, mint or recipient.",
        );
      names.push("create-owner-ata");
      continue;
    }
    if (program !== DLMM_PROGRAM)
      throw new Error(
        "Unsupported program; direct transfers, approvals and token-account closes are not permitted.",
      );
    const entry = Object.entries(specs).find(
      ([, s]) => s.discriminator.length === 8 && s.discriminator.every((v, i) => ix.data[i] === v),
    );
    if (!entry) throw new Error("Unknown DLMM instruction.");
    const [name, spec] = entry;
    const init = ["initialize_bin_array", "initialize_bin_array_bitmap_extension"].includes(name);
    const permitted =
      b.action === "claim"
        ? ["claim_fee", "claim_fee2"]
        : b.action === "withdraw"
          ? ["remove_liquidity_by_range", "remove_liquidity_by_range2"]
          : ["rebalance_liquidity"];
    if (!(init && b.action === "rebalance") && !permitted.includes(name))
      throw new Error(`Instruction ${name} is outside this mission action.`);
    const accounts = flatAccounts(spec.accounts);
    if (ix.keys.length < accounts.length)
      throw new Error("DLMM instruction is missing required accounts.");
    accounts.forEach((a, i) => {
      const expected = roles[a.name],
        k = ix.keys[i]!;
      const absentOptional =
        (a as typeof a & { optional?: boolean }).optional === true &&
        (k.pubkey.toBase58() === DLMM_PROGRAM ||
          (name === "rebalance_liquidity" && k.pubkey.equals(SystemProgram.programId)));
      if (
        !expected ||
        !(Array.isArray(expected) ? expected : [expected]).includes(k.pubkey.toBase58()) ||
        (a.signer && !k.isSigner) ||
        (a.writable && !k.isWritable && !absentOptional)
      )
        throw new Error(`Unverified DLMM account role: ${a.name}.`);
    });
    if (
      ix.keys
        .slice(accounts.length)
        .some((k) => !b.binArrays.includes(k.pubkey.toBase58()) || !k.isWritable || k.isSigner)
    )
      throw new Error(
        "Unsupported remaining accounts (rewards/transfer hooks are not part of this adapter).",
      );
    const decoded = decode(ix.data);
    if (!decoded || normalized(decoded.name) !== normalized(name))
      throw new Error("Installed IDL could not decode the instruction.");
    const slices = field(field(decoded.data, "remaining_accounts_info") ?? {}, "slices");
    if (slices !== undefined) {
      if (!Array.isArray(slices) || slices.length > 2)
        throw new Error("Transfer hooks or reward slices are unsupported.");
      const seen = new Set<string>();
      for (const slice of slices) {
        const type = field(slice, "accounts_type"),
          kind = type && typeof type === "object" ? Object.keys(type)[0] : "";
        if (
          !kind ||
          Object.keys(type as object).length !== 1 ||
          !["transferhookx", "transferhooky"].includes(normalized(kind)) ||
          seen.has(normalized(kind)) ||
          integer(slice, "length") !== 0
        )
          throw new Error("Transfer hooks or reward slices are unsupported.");
        seen.add(normalized(kind));
      }
    }
    if (init) {
      if (name === "initialize_bin_array") {
        const index = rawSigned(decoded.data, "index");
        const indexBytes = new Uint8Array(8),
          v = new DataView(indexBytes.buffer);
        v.setBigInt64(0, index, true);
        const pda = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("bin_array"), address(b.scope.pool).toBuffer(), indexBytes],
          address(DLMM_PROGRAM),
        )[0].toBase58();
        if (ix.keys[accounts.findIndex((a) => a.name === "bin_array")]?.pubkey.toBase58() !== pda)
          throw new Error("Bin-array PDA/index differs.");
      }
    } else {
      main++;
      if (b.action === "claim" && name === "claim_fee2")
        inRange(decoded.data, "min_bin_id", "max_bin_id", b.source);
      if (b.action === "withdraw") {
        inRange(decoded.data, "from_bin_id", "to_bin_id", b.source);
        if (integer(decoded.data, "bps_to_remove") !== b.bps)
          throw new Error("Withdrawal percentage differs from the review.");
      }
      if (b.action === "rebalance") {
        const p = field(decoded.data, "params");
        if (
          !b.target ||
          raw(p, "max_deposit_x_amount") !== 0n ||
          raw(p, "max_deposit_y_amount") !== 0n
        )
          throw new Error("This adapter permits zero token top-up only.");
        if (
          integer(p, "active_id") !== b.activeId ||
          integer(p, "max_active_bin_slippage") !== b.maxActiveBinSlippage
        )
          throw new Error("Active-bin assumptions differ from the review.");
        const adds = field(p, "adds"),
          removes = field(p, "removes");
        if (
          !Array.isArray(adds) ||
          adds.length !== 1 ||
          !Array.isArray(removes) ||
          removes.length !== 1
        )
          throw new Error("Only one full-range removal and one redeposit are supported.");
        inRange(removes[0], "min_bin_id", "max_bin_id", b.source);
        if (integer(removes[0], "bps") !== 10_000)
          throw new Error("Rebalance removal must be 100%.");
        inRange(adds[0], "min_delta_id", "max_delta_id", {
          lower: b.target.lower - b.activeId,
          upper: b.target.upper - b.activeId,
        });
      }
    }
    names.push(name);
  }
  if (main !== 1) throw new Error("Exactly one native mission action is required.");
  return { names, userX, userY };
}
function rawSigned(o: unknown, key: string) {
  const s = String(field(o, key) ?? "");
  if (!/^-?\d{1,20}$/.test(s)) throw new Error("Invalid signed index.");
  const n = BigInt(s);
  if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error("Index exceeds i64.");
  return n;
}

/** Gross owner-funded system transfers + fee. Refunds do not replenish cumulative budget. */
export async function verifiedOperationSpend(
  t: VersionedTransactionResponse | null,
  expected: { owner: string; messageHash: string; mintX: string; mintY: string },
) {
  if (!t?.meta || !Number.isSafeInteger(t.slot) || t.slot < 1)
    throw new Error("Confirmed transaction metadata is unavailable.");
  const m = t.transaction.message,
    keys = m.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
  if (
    keys.get(0)?.toBase58() !== expected.owner ||
    !m.isAccountSigner(0) ||
    (await executionHash(m.serialize())) !== expected.messageHash
  )
    throw new Error("Receipt message/fee payer differs from the reserved signed action.");
  const fee = t.meta.fee;
  if (!Number.isSafeInteger(fee) || fee < 0) throw new Error("Charged network fee is unavailable.");
  if (t.meta.err)
    return {
      failed: true,
      slot: t.slot,
      spend: { xRaw: "0", yRaw: "0", lamports: String(fee) } satisfies Spend,
    };
  if (!Array.isArray(t.meta.innerInstructions))
    throw new Error("Inner instruction cost evidence is unavailable.");
  let funding = 0n;
  const instructions = [
    ...m.compiledInstructions.map((i) => ({
      programIdIndex: i.programIdIndex,
      accounts: [...i.accountKeyIndexes],
      data: i.data,
    })),
    ...t.meta.innerInstructions.flatMap((g) =>
      g.instructions.map((i) => ({ ...i, data: bs58.decode(i.data) })),
    ),
  ];
  for (const ix of instructions) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== SystemProgram.programId.toBase58()) continue;
    const native: TransactionInstruction = {
      programId: SystemProgram.programId,
      data: Buffer.from(ix.data),
      keys: ix.accounts.map((i) => ({
        pubkey: keys.get(i)!,
        isSigner: m.isAccountSigner(i),
        isWritable: m.isAccountWritable(i),
      })),
    };
    const kind = SystemInstruction.decodeInstructionType(native);
    if (kind === "Transfer") {
      const d = SystemInstruction.decodeTransfer(native);
      if (d.fromPubkey.toBase58() === expected.owner) funding += BigInt(d.lamports);
    } else if (kind === "Create") {
      const d = SystemInstruction.decodeCreateAccount(native);
      if (d.fromPubkey.toBase58() === expected.owner) {
        if (!Number.isSafeInteger(d.lamports)) throw new Error("Unsafe account funding amount.");
        funding += BigInt(d.lamports);
      }
    } else if (ix.accounts[0] === 0)
      throw new Error("Unsupported owner-funded native instruction in receipt.");
  }
  const debit = (mint: string) => {
    const indices = new Set(
      [...(t.meta!.preTokenBalances ?? []), ...(t.meta!.postTokenBalances ?? [])]
        .filter((b) => b.owner === expected.owner && b.mint === mint)
        .map((b) => b.accountIndex),
    );
    let debit = 0n;
    for (const index of indices) {
      const before = t.meta!.preTokenBalances?.find((b) => b.accountIndex === index),
        after = t.meta!.postTokenBalances?.find((b) => b.accountIndex === index);
      for (const b of [before, after])
        if (
          b &&
          (b.owner !== expected.owner ||
            b.mint !== mint ||
            !/^(0|[1-9]\d*)$/.test(b.uiTokenAmount.amount))
        )
          throw new Error("Unverified token balance binding.");
      const delta =
        BigInt(before?.uiTokenAmount.amount ?? "0") - BigInt(after?.uiTokenAmount.amount ?? "0");
      if (delta > 0n) debit += delta;
    }
    return debit.toString();
  };
  return {
    failed: false,
    slot: t.slot,
    spend: {
      xRaw: debit(expected.mintX),
      yRaw: debit(expected.mintY),
      lamports: (BigInt(fee) + funding).toString(),
    } satisfies Spend,
  };
}

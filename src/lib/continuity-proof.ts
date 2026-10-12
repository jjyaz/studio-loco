import type { VersionedTransactionResponse } from "@solana/web3.js";
import { DLMM_PROGRAM } from "./foundry";
import { ACTION_INSTRUCTIONS, CLOSING_INSTRUCTIONS, type ChapterAction } from "./continuity";

export interface InstructionAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
  accounts?: readonly InstructionAccount[];
}
export interface InstructionSpec {
  discriminator: readonly number[] | Uint8Array;
  accounts: readonly InstructionAccount[];
}
export function flatAccounts(accounts: readonly InstructionAccount[]): InstructionAccount[] {
  return accounts.flatMap((a) => (a.accounts ? flatAccounts(a.accounts) : [a]));
}
export function roleIndexes(spec: InstructionSpec) {
  const accounts = flatAccounts(spec.accounts);
  return {
    accounts,
    target: accounts.findIndex((a) => a.name === "position" || a.name === "limit_order"),
    pool: accounts.findIndex((a) => a.name === "lb_pair"),
    owner: accounts.findIndex(
      (a) => (a.name === "owner" || a.name === "sender") && a.signer === true,
    ),
  };
}
/** Direct SDK instructions only. A matching address in a different role is not a binding. */
export function chapterProof(
  t: VersionedTransactionResponse | null,
  expected: {
    owner: string;
    account: string;
    pool: string;
    action: ChapterAction;
    priorIdentityVerified?: boolean;
  },
  specs: Record<string, InstructionSpec>,
) {
  if (!t?.meta || t.meta.err !== null)
    throw new Error("Successful transaction metadata is unavailable.");
  const m = t.transaction.message;
  const keys = m.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
  const index = (key: string) => {
    for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === key) return i;
    return -1;
  };
  const owner = index(expected.owner),
    account = index(expected.account),
    pool = index(expected.pool);
  if (owner < 0 || !m.isAccountSigner(owner))
    throw new Error("Expected wallet did not sign this transaction.");
  if (account < 0 || !m.isAccountWritable(account))
    throw new Error("Transaction does not write the expected account.");
  const names: string[] = [];
  for (const ix of m.compiledInstructions) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== DLMM_PROGRAM) continue;
    const entry = Object.entries(specs).find(
      ([, s]) => s.discriminator.length === 8 && s.discriminator.every((v, i) => ix.data[i] === v),
    );
    if (!entry) continue;
    const [name, spec] = entry,
      roles = roleIndexes(spec);
    if (roles.target < 0 || roles.owner < 0 || roles.accounts[roles.target]?.writable !== true)
      continue;
    if (
      ix.accountKeyIndexes[roles.target] !== account ||
      ix.accountKeyIndexes[roles.owner] !== owner
    )
      continue;
    if (roles.pool >= 0) {
      if (pool < 0 || ix.accountKeyIndexes[roles.pool] !== pool) continue;
      if (roles.accounts[roles.pool]?.writable && !m.isAccountWritable(pool)) continue;
    } else if (!CLOSING_INSTRUCTIONS.includes(name) || !expected.priorIdentityVerified) continue;
    names.push(name);
  }
  const closing = names.some((n) => CLOSING_INSTRUCTIONS.includes(n));
  const allowed =
    expected.action === "close"
      ? [
          ...ACTION_INSTRUCTIONS.close,
          ...ACTION_INSTRUCTIONS.withdraw,
          ...ACTION_INSTRUCTIONS.claim,
        ]
      : ACTION_INSTRUCTIONS[expected.action];
  if (!names.some((n) => allowed.includes(n)))
    throw new Error("No native " + expected.action + " instruction binds the exact account roles.");
  if (expected.action === "close" && !closing)
    throw new Error("No closing instruction binds this target account.");
  if (!Number.isSafeInteger(t.slot) || t.slot < 1) throw new Error("Transaction slot is invalid.");
  const fee =
    Number.isSafeInteger(t.meta.fee) && t.meta.fee >= 0
      ? owner === 0
        ? String(t.meta.fee)
        : "0"
      : null;
  return {
    slot: t.slot,
    feeLamports: fee,
    instructions: [...new Set(names)].slice(0, 12),
    closing,
  };
}

import { installNodeGlobals } from "./polyfills";
installNodeGlobals();
import type { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Lamports kept back from a native SOL "Max" so fees + rent (ATA, position, bin arrays) can still be paid. */
export const SOL_RESERVE_LAMPORTS = new BN(50_000_000); // 0.05 SOL

/**
 * Real wallet balance for a mint in base units. For wrapped SOL the SDK wraps native SOL,
 * so native lamports are returned (existing WSOL token accounts are not counted).
 * Throws on RPC failure — never returns 0 as an error stand-in.
 */
export async function getMintBalance(connection: Connection, owner: PublicKey, mint: string): Promise<BN> {
  const { PublicKey } = await import("@solana/web3.js");
  if (mint === WSOL_MINT) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return new BN(lamports);
  }
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
  return res.value.reduce((acc, a) => {
    const amt = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
    return amt ? acc.add(new BN(amt)) : acc;
  }, new BN(0));
}

/** Spendable for "Max": native SOL keeps a reserve for fees and rent; SPL tokens are spendable in full. */
export function spendable(mint: string, balance: BN): BN {
  if (mint !== WSOL_MINT) return balance;
  return balance.gt(SOL_RESERVE_LAMPORTS) ? balance.sub(SOL_RESERVE_LAMPORTS) : new BN(0);
}

export interface MintInfo {
  address: string;
  decimals: number;
  program: "token" | "token-2022";
  freezeAuthority: string | null;
  mintAuthority: string | null;
  supply: string;
  /** Token-2022 extension names reported by the RPC's parsed mint */
  extensions: string[];
  /** extensions this interface refuses for pool creation */
  blockedExtensions: string[];
}

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

/**
 * Conservative policy: extensions that can seize, freeze-by-default or hide balances make
 * a pool unsafe or unusable, so Launch Station refuses them. Anything else is allowed through
 * to the program, whose own checks run during exact-message simulation.
 */
const BLOCKED = new Set(["permanentDelegate", "nonTransferable", "confidentialTransferMint", "defaultAccountState", "pausableConfig"]);
export function classifyExtensions(exts: string[]) {
  return exts.filter((e) => BLOCKED.has(e));
}

type ParsedMint = { parsed?: { type?: string; info?: { decimals: number; freezeAuthority: string | null; mintAuthority: string | null; supply: string; extensions?: { extension: string }[] } } };

/** Pure parser for a getParsedAccountInfo result — shared by fetchMint and tests. */
export function parseMintAccount(address: string, value: { owner: { toBase58(): string }; data: unknown } | null): MintInfo {
  if (!value) throw new Error("No account found at this address on the selected cluster");
  const owner = value.owner.toBase58();
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022) throw new Error("Account is not an SPL token mint");
  const data = value.data as ParsedMint;
  if (data.parsed?.type !== "mint" || !data.parsed.info) throw new Error("Account is not a mint");
  const extensions = (data.parsed.info.extensions ?? []).map((e) => e.extension).filter((e): e is string => typeof e === "string");
  return {
    address,
    decimals: data.parsed.info.decimals,
    program: owner === TOKEN_PROGRAM ? "token" : "token-2022",
    freezeAuthority: data.parsed.info.freezeAuthority,
    mintAuthority: data.parsed.info.mintAuthority,
    supply: data.parsed.info.supply,
    extensions,
    blockedExtensions: classifyExtensions(extensions),
  };
}

/** Validate a mint onchain and read its decimals. */
export async function fetchMint(connection: Connection, address: string): Promise<MintInfo> {
  const { PublicKey } = await import("@solana/web3.js");
  let pk: PublicKey;
  try {
    pk = new PublicKey(address.trim());
  } catch {
    throw new Error("Not a valid Solana address");
  }
  const info = await connection.getParsedAccountInfo(pk, "confirmed");
  return parseMintAccount(pk.toBase58(), info.value);
}

import "./polyfills";
import type { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Real wallet balance for a mint in base units. For wrapped SOL the SDK wraps native SOL,
 * so native lamports are returned. Throws on RPC failure — never returns 0 as an error stand-in.
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

export interface MintInfo {
  address: string;
  decimals: number;
  program: "token" | "token-2022";
  freezeAuthority: string | null;
  mintAuthority: string | null;
  supply: string;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EHFLC1PtJNrJm5gzH8Vf4";

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
  if (!info.value) throw new Error("No account found at this address on the selected cluster");
  const owner = info.value.owner.toBase58();
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022) throw new Error("Account is not an SPL token mint");
  const data = info.value.data as { parsed?: { type?: string; info?: { decimals: number; freezeAuthority: string | null; mintAuthority: string | null; supply: string } } };
  if (data.parsed?.type !== "mint" || !data.parsed.info) throw new Error("Account is not a mint");
  return {
    address: pk.toBase58(),
    decimals: data.parsed.info.decimals,
    program: owner === TOKEN_PROGRAM ? "token" : "token-2022",
    freezeAuthority: data.parsed.info.freezeAuthority,
    mintAuthority: data.parsed.info.mintAuthority,
    supply: data.parsed.info.supply,
  };
}

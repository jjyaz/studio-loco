import bs58 from "bs58";

/** Pure on-chain account verification for DLMM PositionV2 / LimitOrder accounts.
 *  Both layouts start: 8-byte discriminator, lb_pair (32), owner (32). */
export interface AccountLike { owner: { toBase58(): string }; data: Uint8Array | Buffer }
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function verifyDlmmAccount(
  acc: AccountLike | null | undefined,
  want: { programId: string; discriminator: Uint8Array; lbPair: Uint8Array; owner: Uint8Array },
): boolean {
  if (!acc || acc.owner.toBase58() !== want.programId) return false;
  const d = new Uint8Array(acc.data);
  if (d.length < 72 || want.discriminator.length !== 8) return false;
  return eq(d.slice(0, 8), want.discriminator) && eq(d.slice(8, 40), want.lbPair) && eq(d.slice(40, 72), want.owner);
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export const isB58Key = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
};

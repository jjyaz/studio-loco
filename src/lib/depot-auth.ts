/** Wallet login contracts. No tokens, keys, SDK, network or account-email identities. */
import { z } from "zod";
import { Address, Uuid } from "./depot-contracts";

export const DEPOT_WALLET_HEADER = "x-loco-depot-wallet";
export const DEPOT_SESSION_COOKIE = "__Host-loco-depot-session";
export const LOGIN_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const HexSecret = z.string().regex(/^[a-f0-9]{64}$/);
export const LoginChallenge = z.object({
  wallet: Address, domain: z.string().min(1).max(255), nonce: HexSecret,
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type LoginChallenge = z.infer<typeof LoginChallenge>;
export const WalletAccount = z.object({ id: Uuid, wallet: Address, expiresAt: z.string().datetime() }).strict();
export type WalletAccount = z.infer<typeof WalletAccount>;
export function loginMessage(c: LoginChallenge): string {
  return `${c.domain} wants you to sign in with your Solana account:\n${c.wallet}\n\nSign in to your private Studio Loco Depot workspace. This does not authorise a transaction.\n\nURI: https://${c.domain}/app/depot\nVersion: 1\nNonce: ${c.nonce}\nIssued At: ${c.issuedAt}\nExpiration Time: ${c.expiresAt}`;
}
export function validLoginChallenge(c: LoginChallenge, wallet: string, host: string, now = Date.now()) {
  const issued = Date.parse(c.issuedAt), expiry = Date.parse(c.expiresAt);
  return c.wallet === wallet && c.domain === host && issued <= now + 5000 && expiry > now
    && expiry - issued > 0 && expiry - issued <= LOGIN_TTL_MS;
}
export function sessionCookie(token: string, wallet: string, remove = false) {
  Address.parse(wallet);
  if (!HexSecret.safeParse(token).success && !remove) throw new Error("Invalid session secret");
  return `${DEPOT_SESSION_COOKIE}-${wallet}=${remove ? "" : token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : SESSION_TTL_MS / 1000}`;
}
export function readSessionCookie(cookie: string | null, wallet: string) {
  if (!Address.safeParse(wallet).success) return null;
  const name = `${DEPOT_SESSION_COOKIE}-${wallet}`;
  const matches = (cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const parsed = HexSecret.safeParse(matches[0]!.slice(name.length + 1));
  return parsed.success ? parsed.data : null;
}

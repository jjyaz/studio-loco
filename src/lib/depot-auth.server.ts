/** First-party wallet sessions. Service-only database, exact principal scopes, no Supabase user impersonation. */
import { z } from "zod";
import { Address } from "./depot-contracts";
import { DEPOT_WALLET_HEADER, HexSecret, LOGIN_TTL_MS, LoginChallenge, WalletAccount, loginMessage, readSessionCookie, sessionCookie, type WalletAccount as Account } from "./depot-auth";
import { proofDomain, randomNonce, sha256Hex, verifyWalletSignature } from "./depot.server";

export type AuthRpc = (name: string, args: Record<string, string>) => Promise<{ data: unknown; error: unknown }>;
async function defaultRpc(): Promise<AuthRpc> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return (name, args) => supabaseAdmin.rpc(name as never, args as never) as never;
}
const digest = (s: string) => sha256Hex(new TextEncoder().encode(s));
const json = (body: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Cookie, X-Loco-Depot-Wallet", "X-Content-Type-Options": "nosniff", ...(cookie ? { "Set-Cookie": cookie } : {}) },
});
function scope(request: Request, mutation: boolean) {
  const host = proofDomain(request.headers.get("host") ?? new URL(request.url).host);
  if (!host || host.startsWith("localhost")) throw new Error("Wallet sign-in requires an approved HTTPS site.");
  if (mutation && request.headers.get("origin") !== `https://${host}`) throw new Error("Request origin does not match this site.");
  const wallet = Address.parse(request.headers.get(DEPOT_WALLET_HEADER));
  return { domain: host, wallet };
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON request required.");
  if (Number(request.headers.get("content-length") ?? 0) > 4096) throw new Error("Request too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body required.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const r = await reader.read(); if (r.done) break;
      size += r.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error("Request too large."); }
      chunks.push(r.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
/** Every private request requires BOTH the opaque HttpOnly cookie and matching connected-wallet header. */
export async function depotSession(request: Request, rpc?: AuthRpc): Promise<Account | null> {
  const { domain, wallet } = scope(request, request.method !== "GET");
  const token = readSessionCookie(request.headers.get("cookie"), wallet);
  if (!token) return null;
  const r = await (rpc ?? await defaultRpc())("depot_auth_session", { _token_hash: digest(token), _domain: domain, _wallet: wallet });
  if (r.error) throw new Error("Wallet session verification unavailable.");
  if (!r.data) return null;
  const a = WalletAccount.parse(r.data);
  if (a.wallet !== wallet || Date.parse(a.expiresAt) <= Date.now()) return null;
  return a;
}

/** Injectable RPC for meaningful handler tests; production callers never supply it. */
export async function handleDepotAuth(request: Request, action: string, rpc?: AuthRpc): Promise<Response> {
  try {
    if (action === "session" && request.method === "GET") return json({ ok: true, account: await depotSession(request, rpc) });
    if (request.method !== "POST" || !["challenge", "verify", "logout"].includes(action)) return json({ ok: false, error: "Not found" }, 404);
    const { domain, wallet } = scope(request, true);
    const call = rpc ?? await defaultRpc();
    if (action === "logout") {
      const token = readSessionCookie(request.headers.get("cookie"), wallet);
      if (!token) return json({ ok: true });
      const r = await call("depot_auth_logout", { _token_hash: digest(token), _domain: domain, _wallet: wallet });
      if (r.error) throw new Error("Sign-out could not be confirmed. Try again.");
      // A different tab's wallet session must never be cleared by this wallet.
      return json({ ok: true }, 200, r.data === true ? sessionCookie("", wallet, true) : undefined);
    }
    const input = await body(request);
    if (action === "challenge") {
      const d = z.object({ wallet: Address }).strict().parse(input);
      if (d.wallet !== wallet) throw new Error("Connected wallet changed.");
      const now = Date.now();
      const c = LoginChallenge.parse({ domain, wallet, nonce: randomNonce(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + LOGIN_TTL_MS).toISOString() });
      const r = await call("depot_auth_challenge", { _nonce: c.nonce, _wallet: wallet, _domain: domain, _issued_at: c.issuedAt, _expires_at: c.expiresAt, _ip_hash: digest(request.headers.get("cf-connecting-ip") ?? "unavailable") });
      if (r.error || r.data !== true) return json({ ok: false, error: "Sign-in requests are temporarily limited. Try again shortly." }, 429);
      return json({ ok: true, challenge: c, message: loginMessage(c) });
    }
    const d = z.object({ wallet: Address, nonce: HexSecret, signature: z.string().min(64).max(100) }).strict().parse(input);
    if (d.wallet !== wallet) throw new Error("Connected wallet changed.");
    const n = await call("depot_auth_pending", { _nonce: d.nonce, _wallet: wallet, _domain: domain });
    if (n.error || !n.data) return json({ ok: false, error: "Sign-in challenge expired or was already used. Request another." }, 401);
    const c = LoginChallenge.parse(n.data);
    if (c.wallet !== wallet || c.domain !== domain || c.nonce !== d.nonce || Date.parse(c.issuedAt) > Date.now() + 5000 || Date.parse(c.expiresAt) <= Date.now() || Date.parse(c.expiresAt) - Date.parse(c.issuedAt) > LOGIN_TTL_MS)
      return json({ ok: false, error: "Sign-in challenge expired or changed." }, 401);
    if (!verifyWalletSignature(loginMessage(c), d.signature, wallet)) return json({ ok: false, error: "Signature does not match this wallet and sign-in request." }, 401);
    const secret = randomNonce();
    const r = await call("depot_auth_complete", { _nonce: c.nonce, _wallet: wallet, _domain: domain, _token_hash: digest(secret) });
    if (r.error || !r.data) return json({ ok: false, error: "Sign-in challenge was already used or expired." }, 401);
    const account = WalletAccount.parse(r.data);
    if (account.wallet !== wallet) throw new Error("Session wallet mismatch.");
    return json({ ok: true, account }, 200, sessionCookie(secret, wallet));
  } catch (e) {
    const message = e instanceof z.ZodError ? "Invalid wallet sign-in request." : e instanceof Error ? e.message : "Wallet sign-in unavailable.";
    return json({ ok: false, error: message.replace(/https?:\/\/\S+/g, "[site]").slice(0, 200) }, 400);
  }
}

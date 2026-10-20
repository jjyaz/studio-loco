// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { DEPOT_SESSION_COOKIE, DEPOT_WALLET_HEADER, loginMessage, readSessionCookie, sessionCookie, validLoginChallenge, type LoginChallenge } from "@/lib/depot-auth";
import { handleDepotAuth, depotSession, type AuthRpc } from "@/lib/depot-auth.server";
import { sha256Hex } from "@/lib/depot.server";

const sk = new Uint8Array(32).fill(71), pk = bs58.encode(ed25519.getPublicKey(sk));
const other = bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(72)));
const domain = "studioloco.cfd", accountId = "00000000-0000-4000-8000-000000000011";
function request(action: string, data?: unknown, opts: { wallet?: string; origin?: string; cookie?: string; host?: string } = {}) {
  const host = opts.host ?? domain;
  return new Request(`https://${host}/api/public/depot/auth/${action}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { host, origin: opts.origin ?? `https://${host}`, [DEPOT_WALLET_HEADER]: opts.wallet ?? pk, "Content-Type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
function database() {
  let pending: LoginChallenge | null = null, used = false, hash = "", revoked = false;
  const account = () => ({ id: accountId, wallet: pk, expiresAt: new Date(Date.now() + 43_200_000).toISOString() });
  const rpc = vi.fn<AuthRpc>(async (name, a) => {
    if (name === "depot_auth_challenge") { pending = { wallet: a["_wallet"]!, domain: a["_domain"]!, nonce: a["_nonce"]!, issuedAt: a["_issued_at"]!, expiresAt: a["_expires_at"]! }; return { data: true, error: null }; }
    if (name === "depot_auth_pending") return { data: !used && pending?.nonce === a["_nonce"] ? pending : null, error: null };
    if (name === "depot_auth_complete") { if (used) return { data: null, error: null }; used = true; hash = a["_token_hash"]!; return { data: account(), error: null }; }
    const valid = a["_token_hash"] === hash && a["_wallet"] === pk && a["_domain"] === domain && !revoked;
    if (name === "depot_auth_session") return { data: valid ? account() : null, error: null };
    if (name === "depot_auth_logout") { if (valid) revoked = true; return { data: valid, error: null }; }
    throw new Error("Unexpected RPC");
  });
  return { rpc, setPending: (c: LoginChallenge) => { pending = c; } };
}
beforeEach(() => Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }));
async function signedLogin(db: ReturnType<typeof database>) {
  const c = await (await handleDepotAuth(request("challenge", { wallet: pk }), "challenge", db.rpc)).json();
  const input = { wallet: pk, nonce: c.challenge.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(c.message), sk)) };
  return { c, input, response: await handleDepotAuth(request("verify", input), "verify", db.rpc) };
}
describe("Depot wallet authentication", () => {
  it("keeps separate wallet cookie names so a late sign-in cannot replace another wallet's session", () => {
    const a = sessionCookie("a".repeat(64), pk).split(";")[0], b = sessionCookie("b".repeat(64), other).split(";")[0];
    expect(a!.split("=")[0]).not.toBe(b!.split("=")[0]);
    expect(readSessionCookie(`${a}; ${b}`, pk)).toBe("a".repeat(64));
    expect(readSessionCookie(`${a}; ${b}`, other)).toBe("b".repeat(64));
  });
  it("verifies a real ed25519 signature and stores only a hash of the HttpOnly secret", async () => {
    const db = database(), { c, response } = await signedLogin(db);
    expect(c.message).toBe(loginMessage(c.challenge));
    const out = await response.json(); expect(response.status).toBe(200); expect(out.account.wallet).toBe(pk);
    expect(Object.keys(out)).toEqual(["ok", "account"]);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/Secure; HttpOnly; SameSite=Strict; Max-Age=43200/);
    const secret = readSessionCookie(cookie, pk)!;
    const complete = db.rpc.mock.calls.find(([name]) => name === "depot_auth_complete")!;
    expect(complete[1]["_token_hash"]).toBe(sha256Hex(new TextEncoder().encode(secret)));
    expect(complete[1]["_token_hash"]).not.toBe(secret);
    expect(await depotSession(request("session", undefined, { cookie }), db.rpc)).toMatchObject({ id: accountId, wallet: pk });
  });
  it("refuses replay and a wrong-wallet signature", async () => {
    const db = database(), { input } = await signedLogin(db);
    expect((await handleDepotAuth(request("verify", input), "verify", db.rpc)).status).toBe(401);
    const db2 = database();
    const c = await (await handleDepotAuth(request("challenge", { wallet: pk }), "challenge", db2.rpc)).json();
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(c.message), new Uint8Array(32).fill(72)));
    expect((await handleDepotAuth(request("verify", { wallet: pk, nonce: c.challenge.nonce, signature: sig }), "verify", db2.rpc)).status).toBe(401);
    expect(db2.rpc.mock.calls.some(([n]) => n === "depot_auth_complete")).toBe(false);
  });
  it("rejects unapproved hosts, cross-site POSTs, mismatched wallet bodies and oversized requests", async () => {
    const db = database();
    for (const opts of [{ host: "evil.example" }, { origin: "https://evil.example" }, { wallet: other }]) {
      expect((await handleDepotAuth(request("challenge", { wallet: pk }, opts), "challenge", db.rpc)).status).toBe(400);
    }
    expect((await handleDepotAuth(request("challenge", { wallet: pk, extra: "x".repeat(5000) }), "challenge", db.rpc)).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("refuses expired and future challenge data before consuming a nonce", async () => {
    const db = database(); const c: LoginChallenge = { wallet: pk, domain, nonce: "a".repeat(64), issuedAt: new Date(Date.now()-600_000).toISOString(), expiresAt: new Date(Date.now()-300_000).toISOString() };
    for (const challenge of [c, { ...c, issuedAt: new Date(Date.now()+60_000).toISOString(), expiresAt: new Date(Date.now()+300_000).toISOString() }]) {
      db.setPending(challenge);
      const input = { wallet: pk, nonce: c.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(loginMessage(challenge)), sk)) };
      expect((await handleDepotAuth(request("verify", input), "verify", db.rpc)).status).toBe(401);
    }
    expect(db.rpc.mock.calls.some(([n]) => n === "depot_auth_complete")).toBe(false);
  });
  it("does not accept a cookie for another connected wallet and logout revokes the session", async () => {
    const db = database(), { response } = await signedLogin(db), cookie = response.headers.get("set-cookie")!;
    expect(await depotSession(request("session", undefined, { cookie, wallet: other }), db.rpc)).toBeNull();
    const wrong = await handleDepotAuth(request("logout", {}, { cookie, wallet: other }), "logout", db.rpc);
    expect(wrong.headers.has("set-cookie")).toBe(false);
    const out = await handleDepotAuth(request("logout", {}, { cookie }), "logout", db.rpc);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await depotSession(request("session", undefined, { cookie }), db.rpc)).toBeNull();
  });
  it("rejects absent/duplicate/malformed cookies and fails closed on database errors", async () => {
    const db = database();
    expect(readSessionCookie(`${DEPOT_SESSION_COOKIE}-${pk}=${"a".repeat(64)}; ${DEPOT_SESSION_COOKIE}-${pk}=${"b".repeat(64)}`, pk)).toBeNull();
    expect(readSessionCookie(`${DEPOT_SESSION_COOKIE}-${pk}=unsafe`, pk)).toBeNull();
    expect(await depotSession(request("session"), db.rpc)).toBeNull(); expect(db.rpc).not.toHaveBeenCalled();
    const rpc: AuthRpc = async () => ({ data: null, error: "offline" });
    const r = await handleDepotAuth(request("session", undefined, { cookie: `${DEPOT_SESSION_COOKIE}-${pk}=${"a".repeat(64)}` }), "session", rpc);
    expect(r.status).toBe(400); expect((await r.json()).ok).toBe(false);
    expect((await handleDepotAuth(request("challenge", { wallet: pk }), "challenge", rpc)).status).toBe(429);
  });
  it("binds challenge text to host, wallet, expiry and nonce", () => {
    const now = Date.now();
    const c: LoginChallenge = { wallet: pk, domain, nonce: "a".repeat(64), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now+300_000).toISOString() };
    expect(validLoginChallenge(c, pk, domain)).toBe(true);
    expect(validLoginChallenge(c, other, domain)).toBe(false);
    expect(validLoginChallenge(c, pk, "evil.example")).toBe(false);
    expect(validLoginChallenge({ ...c, expiresAt: c.issuedAt }, pk, domain)).toBe(false);
  });
});

/**
 * Minimal standards Web Push sender (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291).
 * Worker-safe: noble P-256 for ECDH/ES256, WebCrypto for HKDF/AES-GCM. Server-only — the
 * VAPID private key is derived from the VAPID_PRIVATE_SEED secret and never leaves the server.
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

const enc = new TextEncoder();
export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const p = t + "===".slice((t.length + 3) % 4); return Uint8Array.from(atob(p), (c) => c.charCodeAt(0)); };
const ab = (u: Uint8Array) => new Uint8Array(u) as Uint8Array<ArrayBuffer>;
const cat = (...xs: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of xs) { o.set(x, i); i += x.length; } return o; };

export function vapidKeys(seed: string): { priv: Uint8Array; pub: Uint8Array } {
  if (!seed || seed.length < 32) throw new Error("VAPID seed missing");
  let d = sha256(enc.encode(`studio-loco-vapid:${seed}`));
  while (!p256.utils.isValidPrivateKey(d)) d = sha256(d);
  return { priv: d, pub: p256.getPublicKey(d, false) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(info) }, k, len * 8));
}

/** RFC 8291 aes128gcm body. `asPriv`/`salt` injectable for tests. */
export async function encryptPayload(payload: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, o: { asPriv?: Uint8Array; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Invalid subscription keys");
  const asPriv = o.asPriv ?? p256.utils.randomPrivateKey();
  const asPub = p256.getPublicKey(asPriv, false);
  const shared = p256.getSharedSecret(asPriv, uaPublic, true).slice(1);
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPublic, asPub), 32);
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", ab(cek), "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(nonce) }, key, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([65]), asPub, ct);
}

export function vapidJwt(endpoint: string, priv: Uint8Array, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: "mailto:signals@studioloco.cfd" })));
  const sig = p256.sign(sha256(enc.encode(`${h}.${c}`)), priv).toCompactRawBytes();
  return `${h}.${c}.${b64u(sig)}`;
}

/** Push endpoints must be https on a public host — prevents using the sender as an SSRF probe. */
export function safeEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname) || !u.hostname.includes(".")) return false;
    return endpoint.length <= 1024;
  } catch { return false; }
}

export type PushResult = { ok: true; status: number } | { ok: false; status: number; gone: boolean; error: string };

export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: Record<string, unknown>, seed: string): Promise<PushResult> {
  if (!safeEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, error: "Unsafe endpoint" };
  const { priv, pub } = vapidKeys(seed);
  const body = await encryptPayload(enc.encode(JSON.stringify(payload).slice(0, 3000)), unb64u(sub.p256dh), unb64u(sub.auth));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${vapidJwt(sub.endpoint, priv)}, k=${b64u(pub)}` },
    body, signal: AbortSignal.timeout(10_000),
  });
  if (r.ok) return { ok: true, status: r.status };
  return { ok: false, status: r.status, gone: r.status === 404 || r.status === 410, error: (await r.text().catch(() => "")).slice(0, 200) };
}

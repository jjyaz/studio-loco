/**
 * LOCAL EDUCATIONAL SIMULATION — not a deployed confidential protocol.
 * One browser-held AES-GCM key encrypts contributions; SHA-256 commitments let the
 * tally re-check every decrypted input. No committee, threshold decryption, FHE or ZK.
 */
export type LabMode = "ballot" | "sealed-bid" | "histogram";
export type Phase = "setup" | "open" | "closed" | "tallied";

export interface Sealed {
  id: string;
  label: string;
  iv: string; // base64
  ciphertext: string; // base64
  commitment: string; // hex sha256(salt|value)
  salt: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...Array.from(u)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function newKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function commit(salt: string, value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${value}`)));
}

export async function seal(key: CryptoKey, label: string, value: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return { id: crypto.randomUUID(), label, iv: b64(iv), ciphertext: b64(new Uint8Array(ct)), commitment: await commit(salt, value), salt };
}

export async function open(key: CryptoKey, s: Sealed): Promise<{ value: string; verified: boolean }> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.ciphertext));
  const value = new TextDecoder().decode(pt);
  return { value, verified: (await commit(s.salt, value)) === s.commitment };
}

export function tallyBallot(values: string[], options: string[]) {
  const counts = Object.fromEntries(options.map((o) => [o, 0])) as Record<string, number>;
  let invalid = 0;
  for (const v of values) { if (v in counts) counts[v] = (counts[v] ?? 0) + 1; else invalid++; }
  return { counts, invalid };
}

/** Sealed-bid second-price aggregate: reveals only winner index and clearing price. */
export function tallySealedBid(values: string[]) {
  const bids = values.map(Number).map((n, i) => ({ i, n })).filter((b) => Number.isFinite(b.n) && b.n >= 0).sort((a, b) => b.n - a.n);
  if (!bids.length) return null;
  const top = bids[0]!;
  return { winner: top.i, clearing: bids[1]?.n ?? top.n, count: bids.length };
}

export function tallyHistogram(values: string[], edges: number[]) {
  const buckets = new Array(edges.length + 1).fill(0) as number[];
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    let k = edges.findIndex((e) => n < e);
    if (k === -1) k = edges.length;
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  return buckets;
}

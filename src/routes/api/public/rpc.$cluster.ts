import { createFileRoute } from "@tanstack/react-router";

/**
 * Narrow JSON-RPC relay to Solana's public endpoints. Needed because the public RPC
 * rejects browser-origin requests (HTTP 403). Fixed upstreams, allowlisted methods,
 * validated params, bounded request/response sizes, upstream timeout, no secrets, no logging
 * of request bodies. Users can bypass it entirely with their own RPC in Settings.
 */
// Default upstreams. Mainnet uses PublicNode's free keyless endpoint because
// api.mainnet-beta.solana.com 403s both browser origins and hosted-Worker IPs;
// PublicNode was verified against the real mainnet genesis hash, live slots and
// DLMM program/pool account reads (2026-10-06). Devnet stays on the public
// Solana endpoint — no verified keyless devnet alternative; users can set a
// custom RPC in Settings. Server env overrides always win.
const UPSTREAM: Record<string, string> = {
  mainnet: "https://solana-rpc.publicnode.com",
  devnet: "https://api.devnet.solana.com",
};

export const RELAY_LIMITS = { bodyChars: 200_000, batch: 20, params: 6, responseBytes: 4_000_000, timeoutMs: 15_000 };

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash", "getSlot", "getBlockHeight",
  "getEpochInfo", "getVersion", "getMinimumBalanceForRentExemption", "getFeeForMessage", "simulateTransaction",
  "sendTransaction", "getSignatureStatuses", "getTokenAccountsByOwner", "getProgramAccounts",
  "isBlockhashValid", "getRecentPrioritizationFees", "getTokenAccountBalance", "getHealth", "getGenesisHash",
]);

type Call = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** Returns an error message when a call is malformed or outside the relay's scope. */
export function validateCall(c: Call): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "Each call must be a JSON-RPC object";
  if (c.jsonrpc !== "2.0") return "jsonrpc must be \"2.0\"";
  if (!(typeof c.id === "number" || typeof c.id === "string" || c.id === null)) return "id must be a string, number or null";
  if (typeof c.id === "string" && c.id.length > 64) return "id too long";
  if (typeof c.method !== "string" || !ALLOWED.has(c.method)) return `Method not allowed by relay: ${String(c.method).slice(0, 40)}`;
  if (c.params !== undefined && !Array.isArray(c.params)) return "params must be an array";
  const p = (c.params as unknown[] | undefined) ?? [];
  if (p.length > RELAY_LIMITS.params) return "Too many params";
  if (c.method === "getProgramAccounts") {
    // Only filtered DLMM scans (positions, presets, limit orders) — no unbounded scans of arbitrary programs.
    if (p[0] !== DLMM_PROGRAM) return "getProgramAccounts is limited to the DLMM program";
    const cfg = p[1] as { filters?: unknown } | undefined;
    if (!cfg || !Array.isArray(cfg.filters) || cfg.filters.length === 0) return "getProgramAccounts requires filters";
  }
  if ((c.method === "sendTransaction" || c.method === "simulateTransaction") && typeof p[0] !== "string") return "Transaction must be an encoded string";
  return null;
}

export const MULTI_CHUNK = 10;
const MULTI_MAX_KEYS = 100;
class UpstreamError extends Error { constructor(public status: number) { super(`upstream ${status}`); } }
export const isLargeMulti = (c: Call) =>
  c.method === "getMultipleAccounts" && Array.isArray(c.params) && Array.isArray(c.params[0]) && (c.params[0] as unknown[]).length > MULTI_CHUNK;

async function postOne(upstream: string, c: Call): Promise<unknown> {
  const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c), signal: AbortSignal.timeout(RELAY_LIMITS.timeoutMs) });
  if (!r.ok) throw new UpstreamError(r.status);
  return r.json();
}

/** Splits one getMultipleAccounts call into ≤10-key upstream calls; merges `value` in order. Any chunk error fails the whole call. */
export async function splitMulti(upstream: string, c: Call, post: typeof postOne = postOne): Promise<unknown> {
  const p = c.params as unknown[];
  const keys = p[0] as unknown[];
  if (keys.length > MULTI_MAX_KEYS) return { jsonrpc: "2.0", id: c.id ?? null, error: { code: -32602, message: `Too many accounts (max ${MULTI_MAX_KEYS})` } };
  const parts: unknown[][] = [];
  for (let i = 0; i < keys.length; i += MULTI_CHUNK) parts.push(keys.slice(i, i + MULTI_CHUNK));
  const replies = await Promise.all(parts.map((k, i) => post(upstream, { jsonrpc: "2.0", id: i, method: "getMultipleAccounts", params: [k, ...p.slice(1)] }))) as { result?: { context: unknown; value: unknown[] }; error?: unknown }[];
  const bad = replies.find((r) => r.error || !r.result || !Array.isArray(r.result.value));
  if (bad) return { jsonrpc: "2.0", id: c.id ?? null, error: bad.error ?? { code: -32603, message: "Malformed upstream reply" } };
  return { jsonrpc: "2.0", id: c.id ?? null, result: { context: replies[0]!.result!.context, value: replies.flatMap((r) => r.result!.value) } };
}

const rpcErr = (id: unknown, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

export const Route = createFileRoute("/api/public/rpc/$cluster")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!UPSTREAM[params.cluster]) return new Response("Unknown cluster", { status: 404 });
        // Optional server-side upstream (e.g. a keyed provider) — public Solana RPC blocks hosted-Worker IPs.
        const override = process.env[params.cluster === "mainnet" ? "SOLANA_MAINNET_RPC_URL" : "SOLANA_DEVNET_RPC_URL"];
        const usingOverride = !!override && /^https:\/\//.test(override);
        const upstream = usingOverride ? override! : UPSTREAM[params.cluster]!;
        const len = Number(request.headers.get("content-length") ?? "0");
        if (len > RELAY_LIMITS.bodyChars) return new Response("Body too large", { status: 413 });
        const text = await request.text();
        if (text.length > RELAY_LIMITS.bodyChars) return new Response("Body too large", { status: 413 });
        let body: unknown;
        try { body = JSON.parse(text); } catch { return rpcErr(null, -32700, "Parse error", 400); }
        const calls = (Array.isArray(body) ? body : [body]) as Call[];
        if (calls.length === 0) return rpcErr(null, -32600, "Empty batch", 400);
        if (calls.length > RELAY_LIMITS.batch) return new Response("Batch too large", { status: 413 });
        for (const c of calls) {
          const bad = validateCall(c);
          if (bad) return rpcErr(c?.id, bad.startsWith("Method not allowed") ? -32601 : -32602, bad);
        }
        // PublicNode (default mainnet) answers 403 "Request blocked" to getMultipleAccounts with
        // more than 10 keys (verified 2026-10-06). Split those into ≤10-key requests and merge.
        if (!usingOverride && params.cluster === "mainnet" && calls.some(isLargeMulti)) {
          try {
            const results = [];
            for (const c of calls) results.push(isLargeMulti(c) ? await splitMulti(upstream, c) : await postOne(upstream, c));
            const out = JSON.stringify(Array.isArray(body) ? results : results[0]);
            if (out.length > RELAY_LIMITS.responseBytes) return rpcErr(calls[0]?.id, -32004, "Upstream response too large for the public relay. Use your own RPC in Settings.", 502);
            return new Response(out, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
          } catch (e) {
            const st = e instanceof UpstreamError ? e.status : 0;
            if (st === 429) return rpcErr(calls[0]?.id, 429, "Public RPC rate limit reached. Wait a moment, or add your own RPC in Settings.", 429);
            if (st === 403) return rpcErr(calls[0]?.id, 403, "Public Solana RPC refused the hosted relay (403). Add your own RPC in Settings.", 502);
            return rpcErr(calls[0]?.id, -32003, "Public RPC did not respond in time. Retry, or add your own RPC in Settings.", 504);
          }
        }
        let res: Response;
        try {
          res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text, signal: AbortSignal.timeout(RELAY_LIMITS.timeoutMs) });
        } catch (e) {
          const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
          return rpcErr(calls[0]?.id, -32003, timeout ? "Public RPC did not respond in time. Retry, or add your own RPC in Settings." : "Public RPC unreachable. Retry, or add your own RPC in Settings.", 504);
        }
        if (res.status === 429) return rpcErr(calls[0]?.id, 429, "Public RPC rate limit reached. Wait a moment, or add your own RPC in Settings.", 429);
        if (res.status === 403) return rpcErr(calls[0]?.id, 403, "Public Solana RPC refused the hosted relay (403). Add your own RPC in Settings.", 502);
        const out = await res.text();
        if (out.length > RELAY_LIMITS.responseBytes) return rpcErr(calls[0]?.id, -32004, "Upstream response too large for the public relay. Use your own RPC in Settings.", 502);
        return new Response(out, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      },
    },
  },
});

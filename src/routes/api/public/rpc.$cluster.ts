import { createFileRoute } from "@tanstack/react-router";

/**
 * Narrow JSON-RPC relay to Solana's public endpoints. Needed because the public RPC
 * rejects browser-origin requests (HTTP 403). Only allowlisted methods, small bodies,
 * no secrets. Users can bypass it entirely with their own RPC in Settings.
 */
const UPSTREAM: Record<string, string> = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash", "getSlot", "getBlockHeight",
  "getEpochInfo", "getVersion", "getMinimumBalanceForRentExemption", "getFeeForMessage", "simulateTransaction",
  "sendTransaction", "getSignatureStatuses", "getTokenAccountsByOwner", "getProgramAccounts", "getParsedAccountInfo",
  "isBlockhashValid", "getRecentPrioritizationFees", "getTokenAccountBalance", "getHealth", "getGenesisHash",
]);

export const Route = createFileRoute("/api/public/rpc/$cluster")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const upstream = UPSTREAM[params.cluster];
        if (!upstream) return new Response("Unknown cluster", { status: 404 });
        const text = await request.text();
        if (text.length > 200_000) return new Response("Body too large", { status: 413 });
        let body: unknown;
        try { body = JSON.parse(text); } catch { return new Response("Invalid JSON", { status: 400 }); }
        const calls = Array.isArray(body) ? body : [body];
        if (calls.length > 20) return new Response("Batch too large", { status: 413 });
        for (const c of calls) {
          const m = (c as { method?: unknown })?.method;
          if (typeof m !== "string" || !ALLOWED.has(m)) return Response.json({ jsonrpc: "2.0", id: (c as { id?: unknown })?.id ?? null, error: { code: -32601, message: `Method not allowed by relay: ${String(m)}` } }, { status: 200 });
        }
        const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text });
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      },
    },
  },
});

/** Public immutable metadata/image responses. Digest-addressed; whitelisted body only; no external fetch. */
import type { Database } from "@/integrations/supabase/types";

const HEX64 = /^[0-9a-f]{64}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

type Rpc = (fn: "depot_public_metadata" | "depot_public_image", args: { _digest: string }) => Promise<{ data: unknown; error: unknown }>;

async function defaultRpc(): Promise<Rpc> {
  const { createClient } = await import("@supabase/supabase-js");
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  const c = createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
  return (fn, args) => c.rpc(fn, args) as never;
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function serveMetadata(digest: string, rpc?: Rpc): Promise<Response> {
  if (!HEX64.test(digest)) return notFound();
  const { data, error } = await (rpc ?? (await defaultRpc()))("depot_public_metadata", { _digest: digest });
  if (error || typeof data !== "string") return notFound();
  const { sha256Hex } = await import("./depot.server");
  if (sha256Hex(new TextEncoder().encode(data)) !== digest) return new Response("Integrity failure", { status: 500 });
  return new Response(data, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": IMMUTABLE, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  });
}

export async function serveImage(digest: string, rpc?: Rpc): Promise<Response> {
  if (!HEX64.test(digest)) return notFound();
  const { data, error } = await (rpc ?? (await defaultRpc()))("depot_public_image", { _digest: digest });
  const row = Array.isArray(data) ? (data[0] as { mime?: string; b64?: string } | undefined) : undefined;
  if (error || !row?.b64 || !["image/png", "image/jpeg", "image/webp"].includes(row.mime ?? "")) return notFound();
  const bytes = Uint8Array.from(atob(row.b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  const { sha256Hex } = await import("./depot.server");
  if (sha256Hex(bytes) !== digest) return new Response("Integrity failure", { status: 500 });
  return new Response(bytes, {
    headers: { "Content-Type": row.mime!, "Cache-Control": IMMUTABLE, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" },
  });
}

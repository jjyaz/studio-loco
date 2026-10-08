import { createMcpHandler } from "@modelcontextprotocol/server";
import { Buffer } from "buffer";
import { createLocoMcpServer } from "../../packages/sdk/src/mcp";
import { LocoError } from "../../packages/sdk/src/client";
import { PoolQuerySchema } from "../../packages/sdk/src/contracts";
import { publicReaders, readPool, readPools, readPosition } from "./loco-api.server";
import { LOCO_OPENAPI } from "./loco-openapi";
import release from "./loco-sdk-release.json";

export const LOCO_PREFIX = "/api/public/loco/v1/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, X-Checksum-Sha256",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const handler = createMcpHandler(
  (ctx) =>
    createLocoMcpServer(publicReaders(ctx.requestInfo?.signal), {
      signal: ctx.requestInfo?.signal,
    }),
  { legacy: "stateless", maxRequestBodySize: 16384, keepAliveMs: 0 },
);
function queryObject(url: URL, allowed: string[]) {
  const q: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k) || k in q)
      throw new LocoError("invalid-input", "Unknown or repeated query parameter", 400);
    q[k] = v;
  }
  return q;
}
export async function handleLocoRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(LOCO_PREFIX))
      return json(
        {
          ok: false,
          error: { code: "not-found", message: "API route not found", retryable: false },
        },
        404,
      );
    const path = url.pathname.slice(LOCO_PREFIX.length);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "mcp") {
      queryObject(url, []);
      const origin = request.headers.get("Origin");
      // Public stateless reads support remote hosts; browser-origin requests are restricted.
      if (
        origin &&
        origin !== url.origin &&
        !["https://studioloco.cfd", "https://www.studioloco.cfd"].includes(origin)
      )
        return json(
          {
            ok: false,
            error: { code: "forbidden-origin", message: "Origin is not allowed", retryable: false },
          },
          403,
        );
      const response = await handler.fetch(request);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }
    if (request.method !== "GET")
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "method-not-allowed",
            message: "Use GET for public reads",
            retryable: false,
          },
        }),
        {
          status: 405,
          headers: { ...cors, Allow: "GET, OPTIONS", "Content-Type": "application/json" },
        },
      );
    if (path === "capabilities") {
      queryObject(url, []);
      return json(await publicReaders().capabilities());
    }
    if (path === "openapi.json") {
      queryObject(url, []);
      return json(LOCO_OPENAPI);
    }
    if (path === `sdk/${release.version}.tgz`) {
      queryObject(url, []);
      return new Response(Buffer.from(release.base64, "base64"), {
        headers: {
          ...cors,
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename=studio-loco-sdk-${release.version}.tgz`,
          "X-Checksum-Sha256": release.sha256,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (path === "pools") {
      const raw = queryObject(url, ["page", "perPage", "query", "sort", "direction"]);
      const q = PoolQuerySchema.safeParse({
        ...raw,
        ...(raw["page"] !== undefined ? { page: Number(raw["page"]) } : {}),
        ...(raw["perPage"] !== undefined ? { perPage: Number(raw["perPage"]) } : {}),
      });
      if (!q.success) throw new LocoError("invalid-input", "Invalid pool query", 400);
      return json(await readPools(q.data, request.signal));
    }
    if (/^pools\/[^/]+$/.test(path)) {
      queryObject(url, []);
      return json(await readPool(path.slice(6), request.signal));
    }
    if (/^positions\/[^/]+$/.test(path)) {
      const q = queryObject(url, ["pool"]);
      return json(await readPosition(path.slice(10), q["pool"] ?? "", request.signal));
    }
    throw new LocoError("not-found", "API route not found", 404);
  } catch (e) {
    const error =
      e instanceof LocoError
        ? e
        : new LocoError("internal-error", "The read could not be completed", 500, true);
    return json(
      {
        ok: false,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      },
      error.status ?? 500,
    );
  }
}

import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled Signal Box tick. Caller must present the database-held cron token
 * (generated inside the database, never in code or the browser). Read-only chain work;
 * writes only through the guarded signal_commit function.
 */
export const Route = createFileRoute("/api/public/hooks/signal-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!/^[0-9a-f]{64}$/.test(token)) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: ok } = await supabaseAdmin.rpc("signal_verify_cron", { _token: token });
        if (!ok) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const { runTick } = await import("@/lib/signal-worker.server");
        try {
          const r = await runTick(supabaseAdmin);
          return Response.json(r, { headers: { "cache-control": "no-store" } });
        } catch (e) {
          console.error("signal tick failed", e instanceof Error ? e.message.slice(0, 200) : "error");
          return Response.json({ error: "tick failed" }, { status: 500 });
        }
      },
    },
  },
});

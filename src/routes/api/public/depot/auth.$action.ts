import { createFileRoute } from "@tanstack/react-router";
import { handleDepotAuth } from "@/lib/depot-auth.server";

export const Route = createFileRoute("/api/public/depot/auth/$action")({
  server: { handlers: {
    GET: ({ request, params }) => handleDepotAuth(request, params.action),
    POST: ({ request, params }) => handleDepotAuth(request, params.action),
  } },
});

import { createFileRoute } from "@tanstack/react-router";
import { handleLocoRequest } from "@/lib/loco-http.server";
export const Route = createFileRoute("/api/public/loco/v1/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleLocoRequest(request),
      POST: ({ request }) => handleLocoRequest(request),
      OPTIONS: ({ request }) => handleLocoRequest(request),
      DELETE: ({ request }) => handleLocoRequest(request),
      PUT: ({ request }) => handleLocoRequest(request),
      PATCH: ({ request }) => handleLocoRequest(request),
    },
  },
});

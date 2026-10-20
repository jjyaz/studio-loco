import { createFileRoute } from "@tanstack/react-router";
import { serveMetadata } from "@/lib/depot-public.server";

export const Route = createFileRoute("/api/public/depot/metadata/$digest")({
  server: { handlers: { GET: ({ params }) => serveMetadata(params.digest) } },
});

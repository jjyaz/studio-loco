import { createFileRoute } from "@tanstack/react-router";
import { serveImage } from "@/lib/depot-public.server";

export const Route = createFileRoute("/api/public/depot/image/$digest")({
  server: { handlers: { GET: ({ params }) => serveImage(params.digest) } },
});

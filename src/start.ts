import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

// Attach the signed-in user's access token to server-function calls (Signal Box).
// Browser-only: during SSR there is no session, and protected functions are never called from loaders.
const attachAuth = createMiddleware({ type: "function" }).client(async (options) => {
  const { next } = options;
  if (typeof window === "undefined") return next();
  // The Depot uses its own HttpOnly wallet session, checked by requireDepotWalletAuth.
  // Other workspaces retain their existing authenticated Supabase flow.
  const init = (options as typeof options & { headers?: HeadersInit }).headers;
  const walletHeader = init && typeof (init as Headers).get === "function"
    ? (init as Headers).get("x-loco-depot-wallet")
    : new Headers(init).get("x-loco-depot-wallet");
  if (walletHeader !== null) return next();
  const { supabase } = await import("./integrations/supabase/client");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return next(token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
  functionMiddleware: [attachAuth],
}));

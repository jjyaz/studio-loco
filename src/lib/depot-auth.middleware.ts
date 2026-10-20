import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

/** Does not mint Supabase JWTs or weaken table grants. All Depot data queries explicitly scope user_id. */
export const requireDepotWalletAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  setResponseHeader("cache-control", "private, no-store");
  setResponseHeader("vary", "Cookie, X-Loco-Depot-Wallet");
  const { depotSession } = await import("./depot-auth.server");
  const account = await depotSession(getRequest());
  if (!account) throw new Error("Sign in with the connected wallet to open this private workspace.");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return next({ context: { supabase: supabaseAdmin, userId: account.id, authWallet: account.wallet } });
});

import { z } from "zod";
import { JourneyIdentity } from "./journey";
import { StoredOrderRule } from "./journey-signals";
/** Private watch identifiers only. Old alert summaries never supply a transaction or live amount. */
export async function loadJourneyAlert(id: string) {
  z.string().uuid().parse(id);
  const { supabase } = await import("@/integrations/supabase/client");
  const ac = new AbortController(),
    deadline = Date.now() + 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = <T>(work: PromiseLike<T>) =>
    Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            ac.abort();
            reject(new Error("Private alert loading timed out. Retry in Signal Box."));
          },
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  try {
    const { data: auth, error: authError } = await bounded(supabase.auth.getUser());
    if (authError || !auth.user)
      throw new Error("Sign in to the Signal Box account that owns this alert.");
    const { data: a, error: ae } = await bounded(
      supabase
        .from("signal_alerts")
        .select("id,user_id,watch_id,watch_kind,revision,reason,created_at")
        .eq("id", id)
        .eq("user_id", auth.user.id)
        .abortSignal(ac.signal)
        .maybeSingle(),
    );
    if (ae || !a || a.watch_kind !== "order" || !a.watch_id)
      throw new Error("Native order alert unavailable in this account.");
    const { data: w, error: we } = await bounded(
      supabase
        .from("signal_watches")
        .select("id,user_id,kind,revision,status,expires_at,position,pool,owner,rule")
        .eq("id", a.watch_id)
        .eq("user_id", auth.user.id)
        .abortSignal(ac.signal)
        .maybeSingle(),
    );
    if (
      we ||
      !w ||
      w.kind !== "order" ||
      w.revision !== a.revision ||
      w.status !== "active" ||
      !Number.isFinite(Date.parse(w.expires_at)) ||
      Date.parse(w.expires_at) <= Date.now()
    )
      throw new Error(
        "This watch was edited, paused, removed or expired. Review its latest state in Signal Box.",
      );
    const identity = JourneyIdentity.parse({
      kind: "order",
      account: w.position,
      pool: w.pool,
      owner: w.owner,
    });
    return {
      identity,
      expected: StoredOrderRule.parse(w.rule),
      alertId: a.id,
      watchId: w.id,
      reason: a.reason,
      observedAt: a.created_at,
    };
  } finally {
    clearTimeout(timer);
  }
}

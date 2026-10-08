import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RuleSchema, armRule, type Rule } from "./agents";
import { WatchInput, WATCH_TTL_DAYS, parseArbConfig } from "./signal-box";

const PUBLICNODE = "https://solana-rpc.publicnode.com";
const redact = (s: string) => s.replace(/https?:\/\/[^\s"')]+/g, "[url]").slice(0, 300);
const ttl = () => new Date(Date.now() + WATCH_TTL_DAYS * 86_400_000).toISOString();

async function admin() { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }
async function conn() {
  const { Connection } = await import("@solana/web3.js");
  return new Connection(process.env["SOLANA_MAINNET_RPC_URL"] || PUBLICNODE, { commitment: "confirmed", disableRetryOnRateLimit: true });
}

/** Create a watch. Position watches are verified on chain now and armed at the CURRENT active bin. */
export const createWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => WatchInput.parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    if (data.kind === "arb") {
      const v = parseArbConfig(data.config);
      if (!v.ok) return { ok: false as const, error: v.error };
      const { error } = await a.from("signal_watches").insert({ user_id: context.userId, kind: "arb", label: data.label || "SOL/USDC two-pool route", rule: v.cfg as never, expires_at: ttl() });
      return error ? { ok: false as const, error: error.message } : { ok: true as const };
    }
    try {
      const { observePosition } = await import("./signal-worker.server");
      const obs = await observePosition(await conn(), data.position, data.pool, data.owner, null);
      const base: Rule = { ...data.rule, armed: false, baseline: null };
      const rule = armRule(base, obs.activeId, obs.binStep, Date.now());
      const { error } = await a.from("signal_watches").insert({
        user_id: context.userId, kind: "position", label: data.label, position: data.position, pool: data.pool, owner: data.owner,
        rule: { rule, mintX: obs.mintX, mintY: obs.mintY, binStep: obs.binStep } as never, expires_at: ttl(),
      });
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, baseline: obs.activeId, range: [obs.lower, obs.upper] as [number, number] };
    } catch (e) {
      return { ok: false as const, error: redact(e instanceof Error ? e.message : String(e)) };
    }
  });

const Id = z.object({ id: z.string().uuid() });

/** Pause/resume bump the revision so any in-flight tick result is discarded at commit. */
export const setWatchStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Id.extend({ status: z.enum(["active", "paused"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { data: w } = await a.from("signal_watches").select("revision").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (!w) return { ok: false as const, error: "Watch not found" };
    const { error } = await a.from("signal_watches").update({ status: data.status, revision: w.revision + 1, out_run: null, updated_at: new Date().toISOString() }).eq("id", data.id).eq("user_id", context.userId);
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
  });

export const renewWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Id.parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { error, count } = await a.from("signal_watches").update({ expires_at: ttl(), updated_at: new Date().toISOString() }, { count: "exact" }).eq("id", data.id).eq("user_id", context.userId);
    return error || !count ? { ok: false as const, error: error?.message ?? "Watch not found" } : { ok: true as const };
  });

/** Edit rule parameters; re-arms at a fresh verified active bin. Revision bump invalidates in-flight work. */
export const editPositionWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Id.extend({ rule: RuleSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { data: w } = await a.from("signal_watches").select("revision,kind,position,pool,owner,rule").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (!w || w.kind !== "position" || !w.position || !w.pool || !w.owner) return { ok: false as const, error: "Position watch not found" };
    try {
      const { observePosition } = await import("./signal-worker.server");
      const obs = await observePosition(await conn(), w.position, w.pool, w.owner, null);
      const prev = w.rule as { mintX: string; mintY: string };
      if (prev.mintX !== obs.mintX || prev.mintY !== obs.mintY) return { ok: false as const, error: "Pool mint identity changed" };
      const rule = armRule({ ...data.rule, armed: false, baseline: null, revision: (data.rule.revision ?? 0) + 1 }, obs.activeId, obs.binStep, Date.now());
      const { error } = await a.from("signal_watches").update({ rule: { rule, mintX: obs.mintX, mintY: obs.mintY, binStep: obs.binStep } as never, revision: w.revision + 1, out_run: null, last_proposed: {}, updated_at: new Date().toISOString() }).eq("id", data.id).eq("user_id", context.userId);
      return error ? { ok: false as const, error: error.message } : { ok: true as const, baseline: obs.activeId };
    } catch (e) {
      return { ok: false as const, error: redact(e instanceof Error ? e.message : String(e)) };
    }
  });

/* ---------------- Web Push ---------------- */

export const getPushConfig = createServerFn({ method: "GET" }).handler(async () => {
  const seed = process.env["VAPID_PRIVATE_SEED"];
  if (!seed) return { available: false as const };
  const { vapidKeys, b64u } = await import("./webpush.server");
  return { available: true as const, publicKey: b64u(vapidKeys(seed).pub) };
});

const Sub = z.object({ endpoint: z.string().url().max(1024), p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(32) });

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Sub.parse(d))
  .handler(async ({ data, context }) => {
    const { safeEndpoint } = await import("./webpush.server");
    if (!safeEndpoint(data.endpoint)) return { ok: false as const, error: "Unsupported push endpoint" };
    const a = await admin();
    const { count } = await a.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", context.userId);
    if ((count ?? 0) >= 5) return { ok: false as const, error: "Up to 5 devices per account" };
    // An endpoint belongs to one browser profile: re-subscribing moves it to the current account.
    await a.from("push_subscriptions").delete().eq("endpoint", data.endpoint);
    const { error } = await a.from("push_subscriptions").insert({ user_id: context.userId, ...data });
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
  });

export const removePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ endpoint: z.string().max(1024) }).parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    await a.from("push_subscriptions").delete().eq("endpoint", data.endpoint).eq("user_id", context.userId);
    return { ok: true as const };
  });

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const seed = process.env["VAPID_PRIVATE_SEED"];
    if (!seed) return { ok: false as const, error: "Push is not configured" };
    const a = await admin();
    const { data: subs } = await a.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", context.userId).limit(5);
    if (!subs?.length) return { ok: false as const, error: "No subscribed devices" };
    const { sendPush } = await import("./webpush.server");
    let sent = 0;
    for (const s of subs) { const r = await sendPush(s, { title: "Signal Box test", body: "Notifications are working. This is a test, not an alert.", url: "/app/signal-box" }, seed); if (r.ok) sent++; else if (r.gone) await a.from("push_subscriptions").delete().eq("id", s.id); }
    return { ok: true as const, sent, total: subs.length };
  });

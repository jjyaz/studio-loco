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
  const { createRpcFetch } = await import("./rpc-fetch");
  return new Connection(process.env["SOLANA_MAINNET_RPC_URL"] || PUBLICNODE, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: createRpcFetch(fetch, 15_000) });
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
    const { data: w, error: re } = await a.from("signal_watches").select("revision,status").eq("id", data.id).eq("user_id", context.userId).maybeSingle();
    if (re) return { ok: false as const, error: "Could not read the watch. Nothing changed." };
    if (!w) return { ok: false as const, error: "Watch not found" };
    if (w.status === data.status) return { ok: true as const, revision: w.revision, unchanged: true as const };
    const { data: rows, error } = await a.from("signal_watches").update({ status: data.status, revision: w.revision + 1, out_run: null, updated_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", context.userId).eq("revision", w.revision).select("revision");
    if (error) return { ok: false as const, error: "Could not save the change. Nothing changed." };
    if (!rows?.length) return { ok: false as const, error: "The watch changed in another window. Reload and try again." };
    return { ok: true as const, revision: rows[0]!.revision };
  });

export const renewWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Id.parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { data: rows, error } = await a.from("signal_watches").update({ expires_at: ttl(), updated_at: new Date().toISOString() }).eq("id", data.id).eq("user_id", context.userId).select("expires_at");
    if (error) return { ok: false as const, error: "Could not renew the watch. Its expiry is unchanged." };
    if (!rows?.length) return { ok: false as const, error: "Watch not found" };
    return { ok: true as const, expiresAt: rows[0]!.expires_at };
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
      const prevStep = (w.rule as { binStep?: number }).binStep;
      if (prevStep !== undefined && prevStep !== obs.binStep) return { ok: false as const, error: "Pool bin step changed" };
      // Compare-and-swap on the revision read above: a concurrent pause/resume/edit wins and this edit is refused.
      const { data: rows, error } = await a.from("signal_watches").update({ rule: { rule, mintX: obs.mintX, mintY: obs.mintY, binStep: obs.binStep } as never, revision: w.revision + 1, out_run: null, last_proposed: {}, updated_at: new Date().toISOString() })
        .eq("id", data.id).eq("user_id", context.userId).eq("revision", w.revision).select("revision");
      if (error) return { ok: false as const, error: "Could not save the edit. Nothing changed." };
      if (!rows?.length) return { ok: false as const, error: "The watch changed in another window (paused, resumed or edited). Reload and try again." };
      return { ok: true as const, baseline: obs.activeId, revision: rows[0]!.revision };
    } catch (e) {
      return { ok: false as const, error: redact(e instanceof Error ? e.message : String(e)) };
    }
  });

/* ---------------- Web Push ---------------- */

export const getPushConfig = createServerFn({ method: "GET" }).handler(async () => {
  const { vapidKeys, b64u, loadVapidSeed } = await import("./webpush.server");
  const seed = await loadVapidSeed();
  if (!seed) return { available: false as const };
  return { available: true as const, publicKey: b64u(vapidKeys(seed).pub) };
});

const Sub = z.object({ endpoint: z.string().max(1024), p256dh: z.string().min(80).max(100), auth: z.string().min(20).max(24) }).strict();

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Sub.parse(d))
  .handler(async ({ data, context }) => {
    const { safeEndpoint, validSubscriptionKeys } = await import("./webpush.server");
    if (!safeEndpoint(data.endpoint)) return { ok: false as const, error: "This browser's push service isn't supported." };
    if (!validSubscriptionKeys(data.p256dh, data.auth)) return { ok: false as const, error: "The browser returned invalid subscription keys." };
    const a = await admin();
    const { data: r, error } = await a.rpc("signal_save_push", { _user: context.userId, _endpoint: data.endpoint, _p256dh: data.p256dh, _auth: data.auth });
    if (error) return { ok: false as const, error: "Could not save this device. Notifications are off." };
    if (r === "conflict") return { ok: false as const, error: "This browser is already subscribed under a different account. Unsubscribe there first." };
    if (r === "cap") return { ok: false as const, error: "Up to 5 devices per account" };
    return { ok: true as const };
  });

export const removePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ endpoint: z.string().max(1024) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { error } = await a.from("push_subscriptions").delete().eq("endpoint", data.endpoint).eq("user_id", context.userId);
    return error ? { ok: false as const, error: "Could not remove this device on the server." } : { ok: true as const };
  });

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { sendPush, loadVapidSeed } = await import("./webpush.server");
    const seed = await loadVapidSeed();
    if (!seed) return { ok: false as const, error: "Push is not configured" };
    const a = await admin();
    const { data: subs } = await a.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", context.userId).limit(5);
    if (!subs?.length) return { ok: false as const, error: "No subscribed devices" };
    let accepted = 0;
    for (const s of subs) {
      const r = await sendPush(s, { title: "Signal Box test", body: "Notifications are working. This is a test, not an alert." }, seed).catch(() => null);
      if (r?.ok) accepted++;
      else if (r && !r.ok && r.gone) await a.from("push_subscriptions").delete().eq("id", s.id).eq("user_id", context.userId);
    }
    return { ok: true as const, accepted, total: subs.length };
  });

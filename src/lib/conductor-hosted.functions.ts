import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  HostedMissionConfig,
  HostedMissionRow,
  HostedMissionSample,
  validateHostedConfig,
} from "./conductor-hosted";
import { redact } from "./recorder";
const id = z.string().uuid();
const input = z.object({ label: z.string().min(1).max(80), config: HostedMissionConfig }).strict();
const selected =
  "id,label,revision,status,rule,expires_at,last_run_at,last_ok_at,last_error,consecutive_errors,out_run";
const admin = async () => (await import("@/integrations/supabase/client.server")).supabaseAdmin;
const reason = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
export const listHostedMissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    setResponseHeader("cache-control", "private, no-store");
    setResponseHeader("vary", "authorization");
    const a = await admin();
    const { data, error } = await a
      .from("signal_watches")
      .select(selected)
      .eq("user_id", context.userId)
      .eq("kind", "mission")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) throw new Error("Could not read hosted missions.");
    const { data: tick, error: te } = await a
      .from("signal_ticks")
      .select("id,started_at,finished_at,note")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { missions: (data ?? []).map((r) => HostedMissionRow.parse(r)), tick: te ? null : tick };
  });
export const getHostedMissionSamples = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id }).strict().parse(v))
  .handler(async ({ data, context }) => {
    setResponseHeader("cache-control", "private, no-store");
    setResponseHeader("vary", "authorization");
    const a = await admin();
    const { data: w, error: we } = await a
      .from("signal_watches")
      .select("id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .eq("kind", "mission")
      .maybeSingle();
    if (we || !w) throw new Error("Hosted mission is unavailable in this account.");
    const { data: rows, error } = await a
      .from("signal_observations")
      .select("id,revision,observed_at,ok,summary,error")
      .eq("watch_id", data.id)
      .eq("user_id", context.userId)
      .order("id", { ascending: false })
      .limit(60);
    if (error) throw new Error("Could not read private observations.");
    return (rows ?? []).map((r) => ({
      id: r.id,
      revision: r.revision,
      observedAt: r.observed_at,
      sample: HostedMissionSample.parse(r.summary),
    }));
  });
export const createHostedMission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    input
      .extend({ consent: z.literal(true) })
      .strict()
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    try {
      const config = await validateHostedConfig(data.config, Date.now());
      const { mainnetConnection } = await import("./signal-worker.server"),
        { readHostedMission } = await import("./conductor-observer.server");
      await readHostedMission(await mainnetConnection(), config);
      const a = await admin(),
        s = config.policy.policy.scope;
      const { data: row, error } = await a
        .from("signal_watches")
        .insert({
          user_id: context.userId,
          kind: "mission",
          label: data.label,
          pool: s.pool,
          position: s.position,
          owner: s.owner,
          rule: config as never,
          expires_at: new Date(config.policy.policy.expiresAt).toISOString(),
        })
        .select("id")
        .single();
      if (error || !row)
        throw new Error(
          error?.code === "23505"
            ? "This mission already has a hosted copy. Revise it explicitly."
            : "Hosted mission was not saved. The shared five-watch account limit may be reached.",
        );
      return { ok: true as const, id: row.id };
    } catch (e) {
      return { ok: false as const, error: reason(e) };
    }
  });
export const changeHostedMission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({
        id,
        revision: z.number().int().positive().safe(),
        action: z.enum(["pause", "resume", "revise", "remove"]),
        config: HostedMissionConfig.optional(),
      })
      .strict()
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    try {
      const a = await admin();
      const { data: raw, error } = await a
        .from("signal_watches")
        .select(selected)
        .eq("id", data.id)
        .eq("user_id", context.userId)
        .eq("kind", "mission")
        .maybeSingle();
      if (error || !raw) throw new Error("Hosted mission unavailable in this account.");
      const w = HostedMissionRow.parse(raw);
      if (w.revision !== data.revision)
        throw new Error("Hosted mission changed in another window. Refresh first.");
      let config = w.rule;
      if (data.action === "revise") {
        config = await validateHostedConfig(data.config, Date.now());
        if (
          config.missionId !== w.rule.missionId ||
          JSON.stringify(config.policy.policy.scope) !== JSON.stringify(w.rule.policy.policy.scope)
        )
          throw new Error("A hosted revision must preserve exact mission scope.");
        if (
          config.policy.revision <= w.rule.policy.revision ||
          config.policy.sealedAt <= w.rule.policy.sealedAt
        )
          throw new Error("Seal a newer local policy before copying a hosted revision.");
      }
      if (["resume", "revise"].includes(data.action))
        await validateHostedConfig(config, Date.now());
      const rpc = a.rpc as (
        name: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: unknown }>;
      const result = await rpc.call(a, "conductor_observer_change", {
        _user: context.userId,
        _watch: data.id,
        _revision: data.revision,
        _action: data.action,
        _rule: config,
      });
      if (result.error || !(result.data as { ok?: boolean } | null)?.ok)
        throw new Error(
          "Hosted mission changed or the update was refused. Refresh before trying again.",
        );
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: reason(e) };
    }
  });

import { z } from "zod";
import { StoredPositionRule, MAX_OBSERVATION_GAP_MS, parseArbConfig } from "./signal-box";
import type { ArbConfig } from "./arb-math";
import type { OutRun, Rule } from "./agents";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Alert = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  watch_id: z.string().uuid().nullable(),
  watch_kind: z.enum(["position", "arb"]),
  revision: z.number().int().positive(),
  trigger: z.string(),
  reason: z.string(),
  payload: z.unknown(),
  created_at: z.string(),
});
const Watch = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  kind: z.enum(["position", "arb"]),
  cluster: z.literal("mainnet-beta"),
  status: z.enum(["active", "paused"]),
  revision: z.number().int().positive(),
  expires_at: z.string(),
  rule: z.unknown(),
  owner: address.nullable(),
  position: address.nullable(),
  pool: address.nullable(),
  out_run: z.unknown(),
  last_ok_at: z.string().nullable(),
});
const Out = z
  .object({
    startedAt: z.number().int().positive().safe(),
    lastSeen: z.number().int().positive().safe(),
  })
  .strict();
type Common = {
  alertId: string;
  watchId: string;
  watchRevision: number;
  accountId: string;
  reason: string;
  observedAt: string;
  expiresAt: number;
};
export type PositionHandoff = Common & {
  kind: "position";
  owner: string;
  position: string;
  pool: string;
  stored: z.infer<typeof StoredPositionRule>;
  outRun: OutRun | null;
};
export type ArbHandoff = Common & { kind: "arb"; config: ArbConfig };
export type SignalHandoff = PositionHandoff | ArbHandoff;

/** Private identifiers/configuration only; alert payloads never become executable inputs. */
export function validateSignalHandoff(
  rawAlert: unknown,
  rawWatch: unknown,
  accountId: string,
  kind: "position" | "arb",
  now = Date.now(),
): SignalHandoff {
  const a = Alert.parse(rawAlert),
    w = Watch.parse(rawWatch);
  if (
    a.user_id !== accountId ||
    w.user_id !== accountId ||
    a.watch_id !== w.id ||
    a.watch_kind !== kind ||
    w.kind !== kind
  )
    throw new Error("This alert does not belong to this workspace and watch.");
  if (a.revision !== w.revision)
    throw new Error("This watch was edited after the alert. Open its latest rules in Signal Box.");
  const expiry = Date.parse(w.expires_at);
  if (w.status !== "active" || !Number.isFinite(expiry) || expiry <= now)
    throw new Error(
      "This watch is paused or expired. Activate it in Signal Box before loading its rules.",
    );
  const common: Common = {
    alertId: a.id,
    watchId: w.id,
    watchRevision: w.revision,
    accountId,
    reason: a.reason,
    observedAt: a.created_at,
    expiresAt: expiry,
  };
  if (kind === "arb") {
    const p = parseArbConfig(w.rule);
    if (!p.ok) throw new Error(p.error);
    return { ...common, kind, config: p.cfg };
  }
  if (!w.owner || !w.position || !w.pool) throw new Error("Position watch identity is incomplete.");
  const stored = StoredPositionRule.parse(w.rule);
  if (!stored.rule.armed) throw new Error("The hosted position rule is disarmed.");
  const out = Out.safeParse(w.out_run);
  const outRun =
    out.success &&
    out.data.startedAt <= out.data.lastSeen &&
    out.data.lastSeen <= now &&
    now - out.data.lastSeen <= MAX_OBSERVATION_GAP_MS &&
    w.last_ok_at !== null &&
    Math.abs(Date.parse(w.last_ok_at) - out.data.lastSeen) < 10_000
      ? out.data
      : null;
  return {
    ...common,
    kind: "position",
    owner: w.owner,
    position: w.position,
    pool: w.pool,
    stored,
    outRun,
  };
}

/** Preserve the explicitly armed hosted baseline, while invalidating all prior local reviews. */
export function handoffRule(h: PositionHandoff, previous?: Rule): Rule {
  return {
    ...h.stored.rule,
    revision: Math.max(previous?.revision ?? 0, h.stored.rule.revision) + 1,
  };
}

/** Hosted observation continuity is accepted only after a fresh, matching on-chain read. */
export function bridgeHostedOut(
  h: PositionHandoff,
  row: {
    key: string;
    pair: string;
    mintX: string;
    mintY: string;
    binStep: number;
    activeId: number;
    lower: number;
    upper: number;
  },
  now = Date.now(),
): OutRun | undefined {
  if (
    row.key !== h.position ||
    row.pair !== h.pool ||
    row.mintX !== h.stored.mintX ||
    row.mintY !== h.stored.mintY ||
    row.binStep !== h.stored.binStep
  )
    throw new Error("Fresh position/pool identity differs from the hosted watch.");
  if (row.activeId >= row.lower && row.activeId <= row.upper) return undefined;
  const out = h.outRun;
  if (
    !out ||
    now < out.lastSeen ||
    now - out.lastSeen > MAX_OBSERVATION_GAP_MS ||
    now >= h.expiresAt
  )
    return undefined;
  return { startedAt: out.startedAt, lastSeen: now };
}

export async function loadSignalHandoff(
  alertId: string,
  kind: "position" | "arb",
): Promise<SignalHandoff> {
  z.string().uuid().parse(alertId);
  const { supabase } = await import("@/integrations/supabase/client");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user)
      throw new Error("Sign in to the Signal Box account that owns this alert.");
    const user = data.user.id;
    const a = await supabase
      .from("signal_alerts")
      .select("id,user_id,watch_id,watch_kind,revision,trigger,reason,payload,created_at")
      .eq("id", alertId)
      .eq("user_id", user)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (a.error || !a.data?.watch_id)
      throw new Error("Alert unavailable in this account, or its watch was deleted.");
    const w = await supabase
      .from("signal_watches")
      .select(
        "id,user_id,kind,cluster,status,revision,expires_at,rule,owner,position,pool,out_run,last_ok_at",
      )
      .eq("id", a.data.watch_id)
      .eq("user_id", user)
      .abortSignal(controller.signal)
      .maybeSingle();
    if (w.error || !w.data) throw new Error("This alert's watch is no longer available.");
    return validateSignalHandoff(a.data, w.data, user, kind);
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Couldn't load this private alert in time. Retry when connected."));
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

import { z } from "zod";
import { JourneyIdentity, JourneySnapshot, OrderLevel, observationEvents } from "./journey";
import type { TickOutcome } from "./signal-box";
export const OrderWatchInput = JourneyIdentity.omit({ kind: true })
  .extend({ kind: z.literal("order"), label: z.string().max(80).default("") })
  .strict();
export const StoredOrderRule = z
  .object({
    mintX: z.string().max(44),
    mintY: z.string().max(44),
    binStep: z.number().int().positive(),
  })
  .strict();
export const OrderBaseline = z
  .object({
    kind: z.literal("order-baseline"),
    observedAt: z.number().int().positive().safe(),
    slot: z.number().int().positive().safe(),
    levels: z.array(OrderLevel).max(70),
  })
  .strict();
export type OrderBaseline = z.infer<typeof OrderBaseline>;
export const ORDER_OBSERVATION_GAP_MS = 12 * 60_000;
export function orderBaseline(s: Extract<JourneySnapshot, { kind: "order" }>): OrderBaseline {
  return {
    kind: "order-baseline",
    observedAt: s.observedAt,
    slot: s.checkedSlot,
    levels: s.levels,
  };
}
/** Hosted native-order alerts compare successful snapshots only; read gaps reset the baseline. */
export function orderTick(o: {
  watchId: string;
  revision: number;
  owner: string;
  account: string;
  pool: string;
  snapshot: Extract<JourneySnapshot, { kind: "order" }>;
  previous: unknown;
  lastProposed: Record<string, number>;
}): TickOutcome<OrderBaseline> {
  const s = JourneySnapshot.parse(o.snapshot);
  if (s.kind !== "order") throw new Error("An order snapshot is required.");
  const p = OrderBaseline.safeParse(o.previous);
  const previous =
    p.success &&
    p.data.slot <= s.slot &&
    p.data.observedAt < s.observedAt &&
    s.observedAt - p.data.observedAt <= ORDER_OBSERVATION_GAP_MS
      ? p.data
      : null;
  // The schema-validated base fields are irrelevant to level transitions and not historical claims.
  const events = previous
    ? observationEvents({ ...s, observedAt: previous.observedAt, levels: previous.levels }, s)
    : [];
  const changes = events.filter((e) => e.kind === "level");
  const summary = {
    kind: "order",
    state: s.levels.length ? "observed" : "empty account",
    levels: s.levels.length,
    resting: s.levels.filter((l) => l.state === "resting").length,
    partial: s.levels.filter((l) => l.state === "partial").length,
    filled: s.levels.filter((l) => l.state === "filled").length,
    slot: s.slot,
    checkedSlot: s.checkedSlot,
    source: s.source,
    baseline: !previous,
    observedAt: s.observedAt,
    observedAfter: previous?.observedAt ?? null,
  };
  return {
    ok: true,
    summary,
    error: null,
    outRun: orderBaseline(s),
    lastProposed: o.lastProposed,
    alert: changes.length
      ? {
          trigger: "order-level-change",
          reason: changes
            .map((e) => e.detail)
            .join(" ")
            .slice(0, 800),
          dedupe_key: `${o.watchId}:order:r${o.revision}:s${s.checkedSlot}`,
          payload: {
            kind: "order",
            owner: o.owner,
            account: o.account,
            pool: o.pool,
            observedAt: s.observedAt,
            observedAfter: previous?.observedAt ?? null,
            slot: s.slot,
            checkedSlot: s.checkedSlot,
            changes: changes.map((e) => e.detail),
            note: "Observed between successful snapshots, not an exact execution timestamp. Fresh account review required.",
          },
        }
      : null,
  };
}

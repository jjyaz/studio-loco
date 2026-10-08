import { z } from "zod";
const bin = z.number().int().min(-351639).max(351639);
export const RangeInputSchema = z
  .object({
    lower: bin,
    upper: bin,
    active: bin,
    widen: z.object({ lower: bin, upper: bin }).strict().optional(),
  })
  .strict()
  .refine(
    (x) => x.lower <= x.upper && x.upper - x.lower + 1 <= 69,
    "Current range must contain 1–69 bins",
  );
export type RangeInput = z.infer<typeof RangeInputSchema>;
/** Geometry only: no instruction building, cost estimate, simulation, profitability or execution. */
export function planRange(input: RangeInput) {
  const p = RangeInputSchema.parse(input),
    width = p.upper - p.lower + 1;
  const lower = p.active - Math.floor(width / 2),
    upper = lower + width - 1;
  if (lower < -351639 || upper > 351639)
    throw new Error("Recentered range exceeds protocol bin bounds");
  const row = (kind: string, l: number, u: number) => ({
    kind,
    lower: l,
    upper: u,
    width: u - l + 1,
    coversActive: p.active >= l && p.active <= u,
  });
  const options = [row("keep", p.lower, p.upper), row("recenter", lower, upper)];
  if (p.widen) {
    const w = p.widen;
    if (
      w.lower > p.lower ||
      w.upper < p.upper ||
      w.upper - w.lower + 1 <= width ||
      w.upper - w.lower + 1 > 69
    )
      throw new Error("Widen must include the current range and contain more bins, up to 69");
    options.push(row("widen", w.lower, w.upper));
  }
  return {
    source: "local-calculation" as const,
    simulation: false,
    executable: false,
    options,
    notice:
      "Range geometry only. Use the app's Rebalance Planner for fresh native builds, cost checks and user-approved execution.",
  };
}

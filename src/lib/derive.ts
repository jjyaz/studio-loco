import BN from "bn.js";

/** Fee Weather label: observation only, and only when both readings exist. */
export function skyOf(dynamicPct: number | undefined, basePct: number | undefined): "Storm" | "Breezy" | "Calm" | "Unavailable" {
  if (dynamicPct === undefined || basePct === undefined || !Number.isFinite(dynamicPct) || !Number.isFinite(basePct)) return "Unavailable";
  return dynamicPct > basePct * 0.5 ? "Storm" : dynamicPct > 0 ? "Breezy" : "Calm";
}

/** Split an exact integer amount across n bins; remainder goes to the last bin. */
export function splitAmount(total: BN, n: number): BN[] {
  if (n < 1) return [];
  const each = total.divn(n);
  const out = Array.from({ length: n }, () => each.clone());
  out[n - 1] = out[n - 1]!.add(total.sub(each.muln(n)));
  return out;
}

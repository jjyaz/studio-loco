import BN from "bn.js";

/** Result of parsing a user-entered decimal string into raw base units. */
export type ParseResult = { ok: true; raw: BN } | { ok: false; error: string };

const DECIMAL_RE = /^(\d+)(?:\.(\d*))?$/;

/**
 * Exact decimal-string -> integer base units. Never touches floating point.
 * "1.5" with 6 decimals -> 1500000.
 */
export function parseUnits(input: string, decimals: number): ParseResult {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { ok: false, error: "Unsupported token decimals" };
  }
  const s = input.trim().replace(/_/g, "");
  if (s === "") return { ok: false, error: "Enter an amount" };
  const m = DECIMAL_RE.exec(s.startsWith(".") ? `0${s}` : s);
  if (!m) return { ok: false, error: "Use digits and an optional decimal point" };
  const whole = m[1];
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return { ok: false, error: `Max ${decimals} decimal places for this token` };
  }
  const raw = new BN(whole + frac.padEnd(decimals, "0"), 10);
  return { ok: true, raw };
}

/** Integer base units -> exact decimal string (trailing zeros trimmed). */
export function formatUnits(raw: BN | bigint | string | number, decimals: number, maxFrac?: number): string {
  let s = typeof raw === "string" ? raw : raw.toString();
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  s = s.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return (neg ? "-" : "") + s;
  const padded = s.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  let frac = padded.slice(padded.length - decimals);
  if (maxFrac !== undefined && frac.length > maxFrac) frac = frac.slice(0, maxFrac);
  frac = frac.replace(/0+$/, "");
  const wholeFmt = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + (frac ? `${wholeFmt}.${frac}` : wholeFmt);
}

/** Apply a basis-point fraction to a raw amount (floor). */
export function bpsOf(raw: BN, bps: number): BN {
  return raw.mul(new BN(Math.round(bps))).div(new BN(10_000));
}

export function isPositive(raw: BN): boolean {
  return raw.gt(new BN(0));
}

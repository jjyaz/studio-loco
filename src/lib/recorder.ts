/**
 * Flight Recorder — structured, private per-action evidence. Pure model + validation + redaction.
 * Records hold public metadata only: no RPC URLs, tokens, credentials or signed transaction bytes.
 * Post-state is a SEPARATE verified read (getTransaction meta) and never implies realized PnL.
 */
import { z } from "zod";
import type { TxStep } from "./tx";

export const RECORD_KINDS = ["wallet-action", "proposal", "review", "alert-handoff"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const PROVENANCE = ["this-device", "cloud", "import"] as const;

const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
const short = z.string().max(400);

export const StepSchema = z.object({
  label: z.string().max(160),
  phase: z.enum(["idle", "preparing", "simulating", "awaiting-signature", "sending", "confirming", "confirmed", "failed", "rejected", "expired", "unknown", "skipped"]),
  signature: b58.optional(),
  error: short.optional(),
  at: z.number().int().positive(),
}).strict();

export const PostStateSchema = z.object({
  verifiedAt: z.number().int().positive(),
  source: z.literal("getTransaction"),
  signature: b58,
  slot: z.number().int().nonnegative().nullable(),
  err: z.string().max(400).nullable(),
  feeLamports: z.number().int().nonnegative().nullable(),
  solDeltaLamports: z.string().regex(/^-?\d+$/).nullable(),
  tokenDeltas: z.array(z.object({ mint: b58, delta: z.string().regex(/^-?\d+$/), decimals: z.number().int().min(0).max(18) }).strict()).max(20),
  note: z.string().max(200),
}).strict();

export const RecordSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{8,80}$/),
  kind: z.enum(RECORD_KINDS),
  provenance: z.enum(PROVENANCE),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  route: z.string().max(80),
  cluster: z.string().max(20),
  rpc: z.enum(["relay", "custom", "public", "none"]),
  wallet: z.string().max(44),
  title: z.string().max(160),
  status: z.enum(["open", "confirmed", "failed", "rejected", "expired", "unknown", "partial", "info"]),
  links: z.object({ alertId: z.string().max(80).optional(), watchId: z.string().max(80).optional(), proposalId: z.string().max(160).optional(), reviewId: z.string().max(80).optional(), recordId: z.string().max(80).optional() }).strict(),
  context: z.record(z.string().max(60), z.union([z.string().max(400), z.number(), z.boolean(), z.null()])).refine((o) => Object.keys(o).length <= 40, "too many context fields"),
  steps: z.array(StepSchema).max(12),
  timeline: z.array(z.object({ at: z.number().int().positive(), event: z.string().max(60), detail: short }).strict()).max(80),
  postState: z.array(PostStateSchema).max(12),
}).strict();
export type FlightRecord = z.infer<typeof RecordSchema>;

/** Strips anything URL- or secret-shaped from free text. */
export function redact(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"')]+/gi, "[url]")
    .replace(/(api[-_]?key|token|secret|auth)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9+/]{120,}={0,2}/g, "[bytes]")
    .slice(0, 400);
}

export function newId(prefix: string): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${r}`.toLowerCase().slice(0, 80);
}

export function statusFromSteps(steps: { phase: string }[]): FlightRecord["status"] {
  if (!steps.length) return "info";
  const ph = steps.map((s) => s.phase);
  if (ph.some((p) => p === "unknown")) return "unknown";
  if (ph.every((p) => p === "confirmed")) return "confirmed";
  const done = ph.filter((p) => p === "confirmed").length;
  const terminal = ph.every((p) => ["confirmed", "failed", "rejected", "expired", "skipped"].includes(p));
  if (!terminal) return "open";
  if (done > 0) return "partial";
  if (ph.includes("rejected")) return "rejected";
  if (ph.includes("expired")) return "expired";
  return "failed";
}

/** Converts runner steps into recorder steps; drops logs, pending blockhash data and any byte fields. */
export function stepsFromRunner(steps: TxStep[], at: number, prev: FlightRecord["steps"] = []): FlightRecord["steps"] {
  return steps.slice(0, 12).map((s, i) => {
    const p = prev[i];
    const same = p && p.phase === s.phase && p.signature === s.signature;
    return { label: redact(s.label).slice(0, 160), phase: s.phase, ...(s.signature ? { signature: s.signature } : {}), ...(s.error ? { error: redact(s.error) } : {}), at: same ? p.at : at };
  });
}

/** Append-only timeline entries for each phase transition. */
export function phaseEvents(prev: FlightRecord["steps"], next: FlightRecord["steps"]): FlightRecord["timeline"] {
  const out: FlightRecord["timeline"] = [];
  next.forEach((s, i) => {
    const p = prev[i];
    if (!p || p.phase !== s.phase) out.push({ at: s.at, event: `step ${i + 1}: ${s.phase}`, detail: redact(`${s.label}${s.signature ? ` · ${s.signature}` : ""}${s.error ? ` · ${s.error}` : ""}`) });
  });
  return out;
}

/** Strict import: each entry validated, provenance forced to "import". Returns rejected count. */
export function parseImport(raw: unknown): { records: FlightRecord[]; rejected: number } {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { format?: unknown }).format === "studio-loco-flight-recorder/v1" ? (raw as { records?: unknown }).records : null;
  if (!Array.isArray(list)) return { records: [], rejected: 0 };
  const records: FlightRecord[] = [];
  let rejected = 0;
  for (const r of list.slice(0, 2000)) {
    const p = RecordSchema.safeParse(r);
    if (p.success) records.push({ ...p.data, provenance: "import" }); else rejected++;
  }
  return { records, rejected };
}

export function exportBundle(records: FlightRecord[], now = Date.now()) {
  return {
    format: "studio-loco-flight-recorder/v1", exportedAt: new Date(now).toISOString(),
    notice: "Public metadata only. No RPC URLs, credentials or signed transaction bytes. Balance deltas are from transaction metadata and are not realized PnL.",
    records,
  };
}

/** Wallet-owner balance change from a confirmed transaction's metadata (lamports and SPL raw units). */
export function deltasFromMeta(o: {
  wallet: string; accountKeys: string[]; preBalances: number[]; postBalances: number[]; fee: number | null;
  preToken: { owner?: string; mint: string; amount: string; decimals: number }[]; postToken: { owner?: string; mint: string; amount: string; decimals: number }[];
}): { solDeltaLamports: string | null; tokenDeltas: { mint: string; delta: string; decimals: number }[] } {
  const i = o.accountKeys.indexOf(o.wallet);
  const solDeltaLamports = i >= 0 && o.preBalances[i] !== undefined && o.postBalances[i] !== undefined ? (BigInt(o.postBalances[i]!) - BigInt(o.preBalances[i]!)).toString() : null;
  const m = new Map<string, { d: bigint; dec: number }>();
  for (const t of o.preToken) if (t.owner === o.wallet) { const c = m.get(t.mint) ?? { d: 0n, dec: t.decimals }; c.d -= BigInt(t.amount); m.set(t.mint, c); }
  for (const t of o.postToken) if (t.owner === o.wallet) { const c = m.get(t.mint) ?? { d: 0n, dec: t.decimals }; c.d += BigInt(t.amount); m.set(t.mint, c); }
  return { solDeltaLamports, tokenDeltas: [...m].filter(([, v]) => v.d !== 0n).slice(0, 20).map(([mint, v]) => ({ mint, delta: v.d.toString(), decimals: v.dec })) };
}

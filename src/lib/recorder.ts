/**
 * Flight Recorder — structured, private per-action evidence. Pure model + validation + redaction.
 * Records hold public metadata only: no RPC URLs, tokens, credentials or signed transaction bytes.
 * Post-state is a SEPARATE verified read (getTransaction meta) and never implies realized PnL.
 */
import { z } from "zod";
import type { TxStep } from "./tx";

import { SignatureSchema as b58, RecordSchema, MAX_RECORDED_STEPS, MAX_TIMELINE_EVENTS, type FlightRecord } from "../../packages/sdk/src/recorder-schema";
export * from "../../packages/sdk/src/recorder-schema";

/** Strips anything URL- or secret-shaped from free text. */
export function redact(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"')]+/gi, "[url]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[credential]")
    .replace(
      /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|auth)["']?\s*[:=]\s*["']?)[^&\s,"'}]+/gi,
      "$1[redacted]",
    )
    .replace(/\b[A-Za-z0-9+/_-]{120,}={0,2}/g, "[bytes]")
    .slice(0, 400);
}

/** Applied at every persistence boundary, including imported and cloud records. */
export function sanitizeRecord(r: FlightRecord): FlightRecord {
  const context: FlightRecord["context"] = {};
  for (const [key, value] of Object.entries(r.context).slice(0, 40)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const sensitive =
      /apikey|authorization|password|secret|privatekey|mnemonic|credential|accesstoken|refreshtoken|signed(?:tx|transaction)|transactionbytes|txbytes|rpc(?:url|endpoint)/.test(
        normalized,
      ) || /^(auth|seed|token)$/.test(normalized);
    context[redact(key).slice(0, 60)] = sensitive
      ? "[redacted]"
      : typeof value === "string"
        ? redact(value)
        : value;
  }
  return {
    ...r,
    title: redact(r.title).slice(0, 160),
    route: redact(r.route).slice(0, 80),
    cluster: redact(r.cluster).slice(0, 20),
    wallet: redact(r.wallet).slice(0, 44),
    links: Object.fromEntries(
      Object.entries(r.links).map(([k, v]) => [
        k,
        typeof v === "string" ? redact(v).slice(0, k === "proposalId" ? 160 : 80) : v,
      ]),
    ),
    context,
    steps: r.steps.map((s) => ({
      ...s,
      label: redact(s.label).slice(0, 160),
      ...(s.error ? { error: redact(s.error) } : {}),
    })),
    timeline: r.timeline.map((t) => ({
      ...t,
      event: redact(t.event).slice(0, 60),
      detail: redact(t.detail),
    })),
    postState: r.postState.map((p) => ({
      ...p,
      err: p.err ? redact(p.err) : null,
      note: redact(p.note).slice(0, 200),
    })),
  };
}

export function newId(prefix: string): string {
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${r}`.toLowerCase().slice(0, 80);
}

export function statusFromSteps(steps: { phase: string }[]): FlightRecord["status"] {
  if (!steps.length) return "info";
  const ph = steps.map((s) => s.phase);
  if (ph.some((p) => p === "unknown")) return "unknown";
  if (ph.every((p) => p === "confirmed")) return "confirmed";
  const done = ph.filter((p) => p === "confirmed").length;
  const terminal = ph.every((p) =>
    ["confirmed", "failed", "rejected", "expired", "skipped"].includes(p),
  );
  if (!terminal) return "open";
  if (done > 0) return "partial";
  if (ph.includes("rejected")) return "rejected";
  if (ph.includes("expired")) return "expired";
  return "failed";
}

/** Converts runner steps into recorder steps; drops logs, pending blockhash data and any byte fields. */
export function stepsFromRunner(
  steps: TxStep[],
  at: number,
  prev: FlightRecord["steps"] = [],
): FlightRecord["steps"] {
  return steps.slice(0, MAX_RECORDED_STEPS).map((s, i) => {
    const p = prev[i];
    const same =
      p &&
      p.phase === s.phase &&
      p.signature === s.signature &&
      p.error === (s.error ? redact(s.error) : undefined);
    return {
      label: redact(s.label).slice(0, 160),
      phase: s.phase,
      ...(s.signature ? { signature: s.signature } : {}),
      ...(s.error ? { error: redact(s.error) } : {}),
      at: same ? p.at : at,
    };
  });
}

/** Append-only timeline entries for each phase transition. */
export function phaseEvents(
  prev: FlightRecord["steps"],
  next: FlightRecord["steps"],
): FlightRecord["timeline"] {
  const out: FlightRecord["timeline"] = [];
  next.forEach((s, i) => {
    const p = prev[i];
    if (!p || p.phase !== s.phase || p.signature !== s.signature || p.error !== s.error)
      out.push({
        at: s.at,
        event: `step ${i + 1}: ${s.phase}`,
        detail: redact(
          `${s.label}${s.signature ? ` · ${s.signature}` : ""}${s.error ? ` · ${s.error}` : ""}`,
        ),
      });
  });
  return out;
}

/** Strict import: each entry validated, provenance forced to "import". Returns rejected count. */
export function parseImport(raw: unknown): { records: FlightRecord[]; rejected: number } {
  const list =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { format?: unknown }).format === "studio-loco-flight-recorder/v1"
      ? (raw as { records?: unknown }).records
      : null;
  if (!Array.isArray(list)) throw new Error("Not a Flight Recorder export");
  const records: FlightRecord[] = [];
  let rejected = Math.max(0, list.length - 2000);
  for (const r of list.slice(0, 2000)) {
    const p = RecordSchema.safeParse(r);
    if (p.success)
      records.push(
        sanitizeRecord({
          ...p.data,
          id: newId("import"),
          provenance: "import",
          context: { ...p.data.context, importedRecordId: p.data.id },
        }),
      );
    else rejected++;
  }
  return { records, rejected };
}

export function exportBundle(records: FlightRecord[], now = Date.now()) {
  return {
    format: "studio-loco-flight-recorder/v1",
    exportedAt: new Date(now).toISOString(),
    notice:
      "Public metadata only. No RPC URLs, credentials or signed transaction bytes. Balance deltas are from transaction metadata and are not realized PnL.",
    records: records.map((r) => sanitizeRecord(RecordSchema.parse(r))),
  };
}

/** Wallet-owner balance change from a confirmed transaction's metadata (lamports and SPL raw units). */
export function deltasFromMeta(o: {
  wallet: string;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  fee: number | null;
  preToken: { owner?: string; mint: string; amount: string; decimals: number }[];
  postToken: { owner?: string; mint: string; amount: string; decimals: number }[];
}): {
  solDeltaLamports: string | null;
  tokenDeltas: { mint: string; delta: string; decimals: number }[];
} {
  const i = o.accountKeys.indexOf(o.wallet);
  const safe = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n >= 0;
  const solDeltaLamports =
    i >= 0 && safe(o.preBalances[i]) && safe(o.postBalances[i])
      ? (BigInt(o.postBalances[i]!) - BigInt(o.preBalances[i]!)).toString()
      : null;
  const m = new Map<string, { d: bigint; dec: number }>();
  const invalid = new Set<string>();
  const add = (t: (typeof o.preToken)[number], sign: bigint) => {
    if (t.owner !== o.wallet) return;
    if (
      !/^\d{1,30}$/.test(t.amount) ||
      !Number.isInteger(t.decimals) ||
      t.decimals < 0 ||
      t.decimals > 18 ||
      !b58.safeParse(t.mint).success
    ) {
      invalid.add(t.mint);
      return;
    }
    const c = m.get(t.mint) ?? { d: 0n, dec: t.decimals };
    if (c.dec !== t.decimals) {
      invalid.add(t.mint);
      return;
    }
    c.d += sign * BigInt(t.amount);
    m.set(t.mint, c);
  };
  for (const t of o.preToken) add(t, -1n);
  for (const t of o.postToken) add(t, 1n);
  return {
    solDeltaLamports,
    tokenDeltas: [...m]
      .filter(([mint, v]) => !invalid.has(mint) && v.d !== 0n)
      .slice(0, 20)
      .map(([mint, v]) => ({ mint, delta: v.d.toString(), decimals: v.dec })),
  };
}

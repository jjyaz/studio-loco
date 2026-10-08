import { RecordSchema, type FlightRecord } from "./recorder-schema.js";
export { RecordSchema, type FlightRecord } from "./recorder-schema.js";

/** Local-only inspection. Export contents are claims, never independently verified chain state. */
export function analyzeRecorderExport(raw: unknown) {
  const size = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  if (size > 5_000_000) throw new Error("Recorder export exceeds 5 MB");
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Expected a Flight Recorder export");
  const bundle = raw as { format?: unknown; records?: unknown };
  if (
    bundle.format !== "studio-loco-flight-recorder/v1" ||
    !Array.isArray(bundle.records) ||
    bundle.records.length > 2000
  )
    throw new Error("Expected a v1 export with at most 2000 records");
  const valid: FlightRecord[] = [];
  let rejected = 0;
  for (const r of bundle.records) {
    const p = RecordSchema.safeParse(r);
    if (p.success) valid.push(p.data);
    else rejected++;
  }
  const ids = new Set<string>();
  let duplicates = 0;
  const records = valid.filter((r) => {
    if (ids.has(r.id)) {
      duplicates++;
      return false;
    }
    ids.add(r.id);
    return true;
  });
  const statuses: Record<string, number> = {};
  const signatures = new Set<string>();
  let danglingRecordLinks = 0,
    inconsistentConfirmations = 0;
  for (const r of records) {
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    if (r.links.recordId && !ids.has(r.links.recordId)) danglingRecordLinks++;
    if (
      r.kind === "wallet-action" &&
      r.status === "confirmed" &&
      (!r.steps.length || r.steps.some((s) => s.phase !== "confirmed" || !s.signature))
    )
      inconsistentConfirmations++;
    for (const s of r.steps) if (s.signature) signatures.add(s.signature);
  }
  return {
    source: "local-export" as const,
    chainVerified: false,
    accepted: records.length,
    rejected,
    duplicates,
    statuses,
    signaturesRecorded: signatures.size,
    postStateReceiptsRecorded: records.reduce((n, r) => n + r.postState.length, 0),
    danglingRecordLinks,
    inconsistentConfirmations,
    notice:
      "This summary describes user-supplied evidence. Recorded confirmations and transaction metadata have not been rechecked on chain; balance deltas are not realized PnL.",
  };
}

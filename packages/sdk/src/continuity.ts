import { ContinuityBundle, stageStatus } from "./continuity-schema.js";
export {
  ContinuityBundle,
  StrategySchema,
  Chapter,
  SnapshotSummary,
  Stage,
  type Strategy,
  type ContinuityBundle as ContinuityEvidenceBundle,
} from "./continuity-schema.js";

/** Supplied evidence inspection only. No chain recheck, upload, device read or signing. */
export function analyzeContinuityExport(input: unknown) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (new TextEncoder().encode(text).byteLength > 10_000_000)
    throw new Error("Continuity export exceeds 10 MB");
  const bundle = ContinuityBundle.parse(typeof input === "string" ? JSON.parse(input) : input);
  const ids = new Set<string>(),
    signatures = new Map<string, Set<string>>();
  const accounts = new Set<string>(),
    origins = new Set<string>(),
    stages: Record<string, number> = {};
  let chapters = 0,
    omittedChapters = 0;
  for (const s of bundle.strategies) {
    if (ids.has(s.id)) throw new Error("Duplicate strategy ID in supplied evidence");
    ids.add(s.id);
    omittedChapters += s.omittedChapters;
    if (s.origin) origins.add(s.origin.digest);
    s.accounts.forEach((a) => accounts.add(a.account));
    for (const st of s.stages) {
      const state = stageStatus(st);
      stages[state] = (stages[state] ?? 0) + 1;
    }
    for (const c of s.chapters) {
      chapters++;
      const fees = signatures.get(c.signature) ?? new Set<string>();
      if (c.feeLamports !== null) fees.add(c.feeLamports);
      signatures.set(c.signature, fees);
    }
  }
  let fees = 0n,
    unknownCosts = 0,
    conflictingCosts = 0;
  for (const values of signatures.values()) {
    if (values.size === 1) fees += BigInt([...values][0]!);
    else {
      unknownCosts++;
      if (values.size > 1) conflictingCosts++;
    }
  }
  return {
    source: "local-export" as const,
    chainVerified: false as const,
    executable: false as const,
    strategiesRecorded: ids.size,
    accountsReferenced: accounts.size,
    blueprintDigestsReferenced: origins.size,
    chaptersRecorded: chapters,
    omittedChapters,
    signaturesRecorded: signatures.size,
    moveStatesRecorded: stages,
    ownerPaidFeesReportedLamports: fees.toString(),
    unknownCosts,
    conflictingCosts,
    notice:
      "Supplied device evidence, not authenticated chain history. Confirmations, ancestry, fees and snapshots have not been independently rechecked. No wallet access or execution permission; observed balance changes are not realized PnL.",
  };
}

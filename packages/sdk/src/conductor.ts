/** Conductor v1: read-only liquidity missions. No wallet authority or execution permission. */
import { z } from "zod";
import { AddressSchema } from "./contracts.js";

const time = z.number().int().positive().safe();
const uint = z.number().int().nonnegative().safe();
export const MissionRaw = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine(
    (s) => /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= 18446744073709551615n,
    "Amount exceeds u64",
  );
const positiveRaw = MissionRaw.refine((s) => /^[1-9]\d{0,19}$/.test(s), "Amount must be positive");
const bin = z.number().int().min(-443636).max(443636);
const id = z.string().regex(/^[a-z0-9-]{8,70}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MISSION_ACTIONS = ["rebalance", "claim", "withdraw"] as const;
export const CONDUCTOR_ADAPTER = "ordinary-dlmm-read-v1";
export const MISSION_MAX_SAMPLES = 120;
export const MISSION_MAX_BYTES = 2_000_000;
export const MissionScope = z
  .object({
    pool: AddressSchema,
    owner: AddressSchema,
    mintX: AddressSchema,
    mintY: AddressSchema,
    decimalsX: uint.max(18),
    decimalsY: uint.max(18),
    binStep: uint.min(1).max(65535),
    position: AddressSchema.nullable(),
    journeyId: z.string().max(150).nullable(),
  })
  .strict()
  .refine((s) => s.mintX !== s.mintY && !!s.position === !!s.journeyId, "Invalid mission scope");
export type MissionScope = z.infer<typeof MissionScope>;
const ladder = z
  .array(positiveRaw)
  .min(1)
  .max(3)
  .refine(
    (v) =>
      v.every((n) => /^[1-9]\d{0,19}$/.test(n)) &&
      v.every((n, i) => i === 0 || BigInt(n) > BigInt(v[i - 1]!)),
    "Probes must increase strictly; at most three sizes per direction",
  );
export const MissionPolicy = z
  .object({
    v: z.literal(1),
    adapter: z.literal(CONDUCTOR_ADAPTER),
    scope: MissionScope,
    probesX: ladder,
    probesY: ladder,
    maxImpactBps: uint.min(1).max(5000),
    maxSwapFeeBps: uint.min(1).max(10000),
    maxDeployXRaw: MissionRaw,
    maxDeployYRaw: MissionRaw,
    minSolReserveLamports: MissionRaw,
    maxNetworkFeeLamports: positiveRaw,
    allowedActions: z
      .array(z.enum(MISSION_ACTIONS))
      .min(1)
      .max(3)
      .refine((a) => new Set(a).size === a.length),
    cooldownMs: uint.min(60_000).max(86_400_000),
    maxAgeMs: uint.min(30_000).max(150_000),
    expiresAt: time,
    approval: z.literal("fresh-wallet-review"),
  })
  .strict();
export type MissionPolicy = z.infer<typeof MissionPolicy>;
export const MissionPolicyRevision = z
  .object({
    revision: uint.min(1),
    sealedAt: time,
    digest: hash,
    policy: MissionPolicy,
  })
  .strict();
export type MissionPolicyRevision = z.infer<typeof MissionPolicyRevision>;
export async function missionPolicyDigest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(MissionPolicy.parse(input)));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export const MissionQuote = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("quoted"),
      direction: z.enum(["x-to-y", "y-to-x"]),
      inputRaw: positiveRaw,
      consumedRaw: MissionRaw,
      outputRaw: MissionRaw,
      lpFeeRaw: MissionRaw,
      protocolFeeRaw: MissionRaw,
      feeOnInput: z.boolean(),
      binArrays: z.array(AddressSchema).max(4),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      direction: z.enum(["x-to-y", "y-to-x"]),
      inputRaw: positiveRaw,
      reason: z.string().min(1).max(300),
    })
    .strict(),
]);
export type MissionQuote = z.infer<typeof MissionQuote>;
export const MissionSnapshot = z
  .object({
    scope: MissionScope,
    adapter: z.literal(CONDUCTOR_ADAPTER),
    startedAt: time,
    observedAt: time,
    slot: time,
    chainTime: time,
    rpcKind: z.enum(["relay", "custom", "server"]),
    activeId: bin,
    enabled: z.boolean(),
    activated: z.boolean(),
    referencePriceQ64: z.string().regex(/^[1-9]\d{0,59}$/),
    binArrays: z.array(AddressSchema).max(4),
    arraysPerDirection: z.literal(2),
    quotes: z.array(MissionQuote).max(6),
    funds: z
      .object({
        slot: time,
        observedAt: time,
        solLamports: MissionRaw,
        ataXRaw: MissionRaw,
        ataYRaw: MissionRaw,
      })
      .strict()
      .nullable(),
    fundsError: z.string().max(300).nullable(),
    position: z
      .object({
        account: AddressSchema,
        slot: time,
        observedAt: time,
        holdingsXRaw: MissionRaw,
        holdingsYRaw: MissionRaw,
        feeXRaw: MissionRaw,
        feeYRaw: MissionRaw,
        lower: bin,
        upper: bin,
      })
      .strict()
      .nullable(),
    positionError: z.string().max(300).nullable(),
  })
  .strict()
  .refine((s) => s.observedAt >= s.startedAt, "Read time moved backwards")
  .refine(
    (s) =>
      (!s.funds || (s.funds.slot >= s.slot && s.funds.observedAt <= s.observedAt)) &&
      (!s.position || (s.position.slot >= s.slot && s.position.observedAt <= s.observedAt)),
    "Separate read contexts or timestamps moved backwards",
  )
  .refine(
    (s) =>
      new Set(s.binArrays).size === s.binArrays.length &&
      s.quotes.every(
        (q) => q.status !== "quoted" || q.binArrays.every((k) => s.binArrays.includes(k)),
      ),
    "Quote bin arrays differ from loaded coverage",
  );
export type MissionSnapshot = z.infer<typeof MissionSnapshot>;
export type MissionState = "met" | "unmet" | "unknown";
export type MissionCheck = { code: string; state: MissionState; detail: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ceilBps = (n: bigint, d: bigint): number | null => {
  if (d <= 0n || n < 0n) return null;
  const bps = (n * 10000n + d - 1n) / d;
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null;
};
/** Total trading fee includes BOTH SDK fee fields. Protocol fee is not included in `fee`. */
export function missionQuoteMetrics(quote: MissionQuote, referencePriceQ64: string) {
  if (quote.status !== "quoted") return null;
  const q = MissionQuote.parse(quote) as Extract<MissionQuote, { status: "quoted" }>;
  if (!/^[1-9]\d{0,59}$/.test(referencePriceQ64)) throw new Error("Invalid reference price");
  const input = BigInt(q.consumedRaw),
    output = BigInt(q.outputRaw),
    fee = BigInt(q.lpFeeRaw) + BigInt(q.protocolFeeRaw),
    price = BigInt(referencePriceQ64);
  if (q.consumedRaw !== q.inputRaw || output <= 0n || (q.feeOnInput && fee >= input)) return null;
  const netInput = q.feeOnInput ? input - fee : input;
  const grossOutput = q.feeOnInput ? output : output + fee;
  const scale = 1n << 64n;
  const expected = q.direction === "x-to-y" ? netInput * price : netInput * scale;
  const actual = q.direction === "x-to-y" ? grossOutput * scale : grossOutput * price;
  const delta = expected > actual ? expected - actual : actual - expected;
  const impactBps = ceilBps(delta, expected);
  const feeBps = ceilBps(fee, q.feeOnInput ? input : grossOutput);
  if (impactBps === null || feeBps === null) return null;
  return { impactBps, feeBps, totalFeeRaw: fee.toString(), feeOnInput: q.feeOnInput };
}
const fresh = (at: number, now: number, max: number) => now >= at && now - at <= max;
export function evaluateMission(policyInput: unknown, snapshotInput: unknown, now = Date.now()) {
  const p = MissionPolicy.parse(policyInput),
    s = MissionSnapshot.parse(snapshotInput);
  const checks: MissionCheck[] = [];
  const add = (code: string, state: MissionState, detail: string) =>
    checks.push({ code, state, detail });
  const scoped = same(p.scope, s.scope) && p.adapter === s.adapter;
  add(
    "scope",
    scoped ? "met" : "unknown",
    scoped
      ? "Exact pool, owner, mints and account scope match."
      : "Snapshot scope differs from the sealed policy.",
  );
  const current = fresh(s.observedAt, now, p.maxAgeMs) && fresh(s.startedAt, now, p.maxAgeMs);
  add(
    "freshness",
    current ? "met" : "unknown",
    current
      ? "Snapshot is within the policy age limit."
      : "Fresh evidence is required; a stale result cannot pass.",
  );
  add(
    "expiry",
    now < p.expiresAt ? "met" : "unmet",
    now < p.expiresAt
      ? "Policy has not expired."
      : "Policy expired. Seal a new revision to continue.",
  );
  add(
    "pool",
    s.enabled && s.activated ? "met" : "unmet",
    s.enabled && s.activated
      ? "Pool is enabled and activated."
      : "Pool is disabled or not activated.",
  );
  const expected = [...p.probesX.map((n) => ["x-to-y", n]), ...p.probesY.map((n) => ["y-to-x", n])];
  const coverage = same(
    expected,
    s.quotes.map((q) => [q.direction, q.inputRaw]),
  );
  add(
    "coverage",
    coverage ? "met" : "unknown",
    coverage
      ? "Every configured independent probe is represented."
      : "Quote ladder differs from the policy; missing sizes remain unknown.",
  );
  const probes = s.quotes.map((q) => {
    const m = missionQuoteMetrics(q, s.referencePriceQ64);
    const state: MissionState =
      !scoped || !current || !coverage || !m
        ? "unknown"
        : m.impactBps > p.maxImpactBps || m.feeBps > p.maxSwapFeeBps
          ? "unmet"
          : "met";
    add(
      `${q.direction}:${q.inputRaw}`,
      state,
      !m
        ? q.status === "unavailable"
          ? q.reason
          : "Full positive-output consumption could not be established."
        : `Fee-exclusive deviation ${m.impactBps} bps; total swap fee ${m.feeBps} bps (${m.feeOnInput ? "input" : "output"} currency).`,
    );
    return { quote: q, metrics: m, state };
  });
  const fundsFresh = scoped && s.funds !== null && fresh(s.funds.observedAt, now, p.maxAgeMs);
  add(
    "reserve",
    !fundsFresh
      ? "unknown"
      : BigInt(s.funds!.solLamports) >= BigInt(p.minSolReserveLamports)
        ? "met"
        : "unmet",
    !fundsFresh
      ? (s.fundsError ?? "Fresh owner funds are unavailable.")
      : "Observed SOL balance compared with the operating reserve; no spending is assumed.",
  );
  if (p.scope.position) {
    const known =
      scoped &&
      s.position?.account === p.scope.position &&
      fresh(s.position.observedAt, now, p.maxAgeMs);
    add(
      "position",
      known ? "met" : "unknown",
      known
        ? "Tracked-position inventory was independently checked in a separate read context."
        : (s.positionError ?? "Tracked-position inventory is unavailable."),
    );
  }
  const state: MissionState = checks.some((c) => c.state === "unmet")
    ? "unmet"
    : checks.some((c) => c.state === "unknown")
      ? "unknown"
      : "met";
  const directions = (["x-to-y", "y-to-x"] as const).map((direction) => {
    const rows = probes.filter((q) => q.quote.direction === direction);
    return {
      direction,
      configured: direction === "x-to-y" ? p.probesX.length : p.probesY.length,
      quoted: rows.filter((r) => r.metrics !== null).length,
      passing: rows.filter((r) => r.state === "met").length,
      largestPassingRaw: rows
        .filter((r) => r.state === "met")
        .reduce<string | null>(
          (n, r) => (n === null || BigInt(r.quote.inputRaw) > BigInt(n) ? r.quote.inputRaw : n),
          null,
        ),
    };
  });
  return {
    state,
    checks,
    probes,
    directions,
    evaluatedAt: now,
    interpretation:
      "Independent snapshot probes; largest passing configured size is a lower bound on sampled capacity, not maximum depth, continuous coverage, future fills or LP profit.",
  };
}

export const MissionIntent = z
  .object({
    scope: MissionScope,
    action: z.enum(MISSION_ACTIONS),
    spendXRaw: MissionRaw,
    spendYRaw: MissionRaw,
    networkFeeLamports: MissionRaw.nullable(),
    rentLamports: MissionRaw.nullable(),
    nativeSolSpendLamports: MissionRaw.nullable(),
    lastConfirmedActionAt: time.nullable(),
    cooldownEvidenceComplete: z.boolean(),
  })
  .strict();
/** Arithmetic preview only. Passing supplied figures is NEVER simulation or permission to sign. */
export function previewMissionAction(
  policyInput: unknown,
  snapshotInput: unknown,
  intentInput: unknown,
  now = Date.now(),
) {
  const p = MissionPolicy.parse(policyInput),
    s = MissionSnapshot.parse(snapshotInput),
    intent = MissionIntent.parse(intentInput);
  const blocked: string[] = [],
    unknown: string[] = [];
  if (!same(p.scope, intent.scope) || !same(p.scope, s.scope))
    blocked.push("Operation scope differs from the sealed policy.");
  if (!p.allowedActions.includes(intent.action)) blocked.push("This action family is not allowed.");
  if (now >= p.expiresAt) blocked.push("Policy has expired.");
  if (!fresh(s.startedAt, now, p.maxAgeMs) || !fresh(s.observedAt, now, p.maxAgeMs))
    unknown.push("Fresh market evidence is required.");
  if (
    BigInt(intent.spendXRaw) > BigInt(p.maxDeployXRaw) ||
    BigInt(intent.spendYRaw) > BigInt(p.maxDeployYRaw)
  )
    blocked.push("Declared token spending exceeds a per-operation capital ceiling.");
  if (!intent.cooldownEvidenceComplete)
    unknown.push("Complete recent operation evidence is required for cooldown checks.");
  if (
    intent.lastConfirmedActionAt !== null &&
    (now < intent.lastConfirmedActionAt || now - intent.lastConfirmedActionAt < p.cooldownMs)
  )
    blocked.push("Cooldown has not elapsed.");
  if (!s.funds || !fresh(s.funds.observedAt, now, p.maxAgeMs))
    unknown.push("Fresh owner funds are required.");
  if (
    intent.networkFeeLamports === null ||
    intent.rentLamports === null ||
    intent.nativeSolSpendLamports === null
  )
    unknown.push("Native build, exact network fee, rent and SOL funding are still unpriced.");
  if (
    intent.networkFeeLamports !== null &&
    BigInt(intent.networkFeeLamports) > BigInt(p.maxNetworkFeeLamports)
  )
    blocked.push("Network fee exceeds the policy ceiling.");
  if (
    s.funds &&
    intent.networkFeeLamports !== null &&
    intent.rentLamports !== null &&
    intent.nativeSolSpendLamports !== null
  ) {
    const remaining =
      BigInt(s.funds.solLamports) -
      BigInt(intent.networkFeeLamports) -
      BigInt(intent.rentLamports) -
      BigInt(intent.nativeSolSpendLamports);
    if (remaining < BigInt(p.minSolReserveLamports))
      blocked.push("Declared SOL outflow would breach the reserve.");
  }
  return {
    state: blocked.length
      ? ("blocked" as const)
      : unknown.length
        ? ("needs-fresh-evidence" as const)
        : ("fits-declared-limits" as const),
    blocked,
    unknown,
    executable: false as const,
    note: "Read-only preview. No cumulative reservation, instruction/recipient verification, simulation or execution authority. Existing stations require their own fresh review and do not enforce this policy yet.",
  };
}

export const MissionSample = z
  .object({
    seq: uint.min(1),
    policyRevision: uint.min(1),
    policyDigest: hash,
    recordedAt: time,
    snapshot: MissionSnapshot,
    recordId: id,
  })
  .strict();
export type MissionSample = z.infer<typeof MissionSample>;
export const ConductorMission = z
  .object({
    v: z.literal(1),
    id,
    label: z.string().trim().min(1).max(80),
    revision: uint.min(1),
    createdAt: time,
    updatedAt: time,
    status: z.enum(["paused", "monitoring"]),
    policies: z.array(MissionPolicyRevision).min(1).max(20),
    samples: z.array(MissionSample).max(MISSION_MAX_SAMPLES),
    omittedSamples: uint,
    gaps: z
      .array(z.object({ at: time, afterSeq: uint, reason: z.string().min(1).max(300) }).strict())
      .max(120),
    omittedGaps: uint,
    recorderLinks: z.array(z.object({ recordId: id, savedAt: time }).strict()).max(140),
    lastError: z.string().max(300).nullable(),
    lastAttempt: time.nullable(),
  })
  .strict();
export type ConductorMission = z.infer<typeof ConductorMission>;
export const missionPolicyRecordId = (id: string, rev: number) => `${id}-p${rev}`;
export const missionSampleRecordId = (id: string, seq: number) => `${id}-s${seq}`;
export const ConductorBundle = z
  .object({
    format: z.literal("studio-loco-conductor"),
    version: z.literal(1),
    exportedAt: time,
    interpretation: z.literal("supplied-read-only-evidence"),
    mission: ConductorMission,
  })
  .strict();
export function exportMission(mission: ConductorMission, now = Date.now()) {
  return ConductorBundle.parse({
    format: "studio-loco-conductor",
    version: 1,
    exportedAt: now,
    interpretation: "supplied-read-only-evidence",
    mission,
  });
}
/** Structural, policy-digest and deterministic arithmetic validation; never chain authentication. */
export async function analyzeMissionExport(input: unknown) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MISSION_MAX_BYTES)
    throw new Error("Conductor bundle exceeds 2 MB.");
  const { mission: m } = ConductorBundle.parse(
    typeof input === "string" ? JSON.parse(input) : input,
  );
  const scope = m.policies[0]!.policy.scope;
  for (let i = 0; i < m.policies.length; i++) {
    const p = m.policies[i]!;
    if (
      p.revision !== i + 1 ||
      p.digest !== (await missionPolicyDigest(p.policy)) ||
      !same(p.policy.scope, scope) ||
      p.policy.expiresAt <= p.sealedAt ||
      p.sealedAt < m.createdAt ||
      (i && p.sealedAt <= m.policies[i - 1]!.sealedAt)
    )
      throw new Error("Policy history or digest is inconsistent.");
  }
  let previousSlot = 0,
    previousAt = 0,
    previousPolicy = 0;
  const outcomes = { met: 0, unmet: 0, unknown: 0 };
  for (let i = 0; i < m.samples.length; i++) {
    const sample = m.samples[i]!,
      p = m.policies[sample.policyRevision - 1];
    if (
      !p ||
      sample.seq !== m.omittedSamples + i + 1 ||
      sample.policyDigest !== p.digest ||
      sample.recordId !== missionSampleRecordId(m.id, sample.seq) ||
      sample.recordedAt < p.sealedAt ||
      sample.snapshot.startedAt < p.sealedAt ||
      sample.snapshot.observedAt > sample.recordedAt ||
      sample.snapshot.slot < previousSlot ||
      sample.recordedAt <= previousAt ||
      sample.policyRevision < previousPolicy ||
      !same(sample.snapshot.scope, scope)
    )
      throw new Error("Observation history or policy binding is inconsistent.");
    outcomes[evaluateMission(p.policy, sample.snapshot, sample.recordedAt).state]++;
    previousSlot = sample.snapshot.slot;
    previousAt = sample.recordedAt;
    previousPolicy = sample.policyRevision;
  }
  const expectedRecords = new Set([
    ...m.policies.map((p) => missionPolicyRecordId(m.id, p.revision)),
    ...m.samples.map((s) => s.recordId),
  ]);
  if (
    new Set(m.recorderLinks.map((r) => r.recordId)).size !== m.recorderLinks.length ||
    m.recorderLinks.some((r) => !expectedRecords.has(r.recordId))
  )
    throw new Error("Recorder links do not match retained evidence.");
  if (
    m.createdAt !== m.policies[0]!.sealedAt ||
    m.gaps.some(
      (g, i) =>
        g.at < m.createdAt ||
        g.afterSeq > (m.samples.at(-1)?.seq ?? m.omittedSamples) ||
        (i > 0 && g.at < m.gaps[i - 1]!.at),
    )
  )
    throw new Error("Read-gap history or mission origin is inconsistent.");
  return {
    interpretation: "supplied-read-only-evidence" as const,
    independentlyVerified: false as const,
    executable: false as const,
    missionId: m.id,
    policyRevisions: m.policies.length,
    retainedObservations: m.samples.length,
    omittedObservations: m.omittedSamples,
    retainedReadGaps: m.gaps.length,
    omittedReadGaps: m.omittedGaps,
    sampledOutcomes: outcomes,
    note: "Recomputed at recorded times, not current health. Supplied RPC observations and Recorder links are not authenticated chain receipts, continuous compliance, execution permission or investment performance.",
  };
}

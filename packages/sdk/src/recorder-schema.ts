import { z } from "zod";

export const RECORD_KINDS = ["wallet-action", "proposal", "review", "alert-handoff"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const PROVENANCE = ["this-device", "cloud", "import"] as const;

export const SignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/);
const short = z.string().max(400);
export const MAX_RECORDED_STEPS = 256;
export const MAX_TIMELINE_EVENTS = 512;

export const StepSchema = z
  .object({
    label: z.string().max(160),
    phase: z.enum([
      "idle",
      "preparing",
      "simulating",
      "awaiting-signature",
      "sending",
      "confirming",
      "confirmed",
      "failed",
      "rejected",
      "expired",
      "unknown",
      "skipped",
    ]),
    signature: SignatureSchema.optional(),
    error: short.optional(),
    at: z.number().int().positive(),
  })
  .strict();

export const PostStateSchema = z
  .object({
    verifiedAt: z.number().int().positive(),
    source: z.literal("getTransaction"),
    signature: SignatureSchema,
    slot: z.number().int().nonnegative().safe().nullable(),
    err: z.string().max(400).nullable(),
    feeLamports: z.number().int().nonnegative().safe().nullable(),
    solDeltaLamports: z
      .string()
      .regex(/^-?\d+$/)
      .nullable(),
    tokenDeltas: z
      .array(
        z
          .object({
            mint: SignatureSchema,
            delta: z.string().regex(/^-?\d+$/),
            decimals: z.number().int().min(0).max(18),
          })
          .strict(),
      )
      .max(20),
    note: z.string().max(200),
  })
  .strict();

export const RecordSchema = z
  .object({
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
    status: z.enum([
      "open",
      "confirmed",
      "failed",
      "rejected",
      "expired",
      "unknown",
      "partial",
      "info",
    ]),
    links: z
      .object({
        alertId: z.string().max(80).optional(),
        watchId: z.string().max(80).optional(),
        proposalId: z.string().max(160).optional(),
        reviewId: z.string().max(80).optional(),
        recordId: z.string().max(80).optional(),
      })
      .strict(),
    context: z
      .record(
        z.string().max(60),
        z.union([z.string().max(400), z.number().finite(), z.boolean(), z.null()]),
      )
      .refine((o) => Object.keys(o).length <= 40, "too many context fields"),
    steps: z.array(StepSchema).max(MAX_RECORDED_STEPS),
    timeline: z
      .array(
        z
          .object({ at: z.number().int().positive(), event: z.string().max(60), detail: short })
          .strict(),
      )
      .max(MAX_TIMELINE_EVENTS),
    postState: z.array(PostStateSchema).max(MAX_RECORDED_STEPS),
  })
  .strict();
export type FlightRecord = z.infer<typeof RecordSchema>;

/** Depot transport contracts. Client-safe: no SDK, no secrets. All raw integers are decimal strings. */
import { z } from "zod";

export const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");
export const RawAmount = z.string().regex(/^[1-9]\d{0,19}$/, "Positive raw integer").refine((s) => BigInt(s) <= 18_446_744_073_709_551_615n, "Exceeds u64");
export const Uuid = z.string().uuid();

export const PROOF_TTL_MS = 5 * 60_000;
export const PROOF_PURPOSES = ["controller", "viewer"] as const;
export type ProofPurpose = (typeof PROOF_PURPOSES)[number];
/** Hosts that may appear in a signed challenge. Anything else is refused server-side. */
export const PROOF_DOMAINS = [
  "studioloco.cfd",
  "www.studioloco.cfd",
  "studio-loco.lovable.app",
  "id-preview--24853ceb-2343-4b7d-9ed0-298ff931d003.lovable.app",
  "localhost:8080",
] as const;

export interface ProofChallenge {
  domain: string;
  purpose: ProofPurpose;
  agentId: string;
  wallet: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/** Exact UTF-8 text the wallet signs. Any field change produces a different message. */
export function proofMessage(c: ProofChallenge): string {
  return [
    `${c.domain} asks you to prove control of a Solana wallet for Studio Loco Depot.`,
    "",
    `Purpose: ${c.purpose === "controller" ? "agent controller" : "report viewer"}`,
    `Agent: ${c.agentId}`,
    `Wallet: ${c.wallet}`,
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expires At: ${c.expiresAt}`,
    "",
    "Signing this message does not approve any transaction or move funds.",
  ].join("\n");
}

export const AgentDraftInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(600).default(""),
    mission: z.literal("scout").default("scout"),
  })
  .strict();

export const AgentUpdateInput = z
  .object({
    id: Uuid,
    revision: z.number().int().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(600).optional(),
    reportPolicy: z.enum(["public", "token-holders"]).optional(),
    gateMint: Address.nullable().optional(),
    gateMinRaw: RawAmount.nullable().optional(),
    gateMaxAgeS: z.number().int().min(10).max(300).optional(),
  })
  .strict();

export const ChallengeInput = z.object({ agentId: Uuid, wallet: Address, purpose: z.enum(PROOF_PURPOSES) }).strict();
export const VerifyInput = z
  .object({
    agentId: Uuid,
    wallet: Address,
    purpose: z.enum(PROOF_PURPOSES),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/),
  })
  .strict();

export const PublishInput = z.object({ id: Uuid, revision: z.number().int().min(1), publish: z.boolean() }).strict();

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 262_144;
export const MetadataInput = z
  .object({
    agentId: Uuid,
    name: z.string().trim().min(1).max(32).refine((s) => new TextEncoder().encode(s).length <= 32, "Name max 32 bytes"),
    symbol: z.string().regex(/^[A-Z0-9]{1,10}$/, "Symbol 1–10 uppercase letters/digits"),
    description: z.string().trim().max(500),
    imageBase64: z.string().min(8).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
    imageMime: z.enum(IMAGE_MIMES),
    confirmImmutable: z.literal(true),
  })
  .strict();

export const ScoutInput = z
  .object({
    agentId: Uuid,
    pool: Address,
    probesX: z.array(RawAmount).min(1).max(3),
    probesY: z.array(RawAmount).min(1).max(3),
    withAi: z.boolean().default(false),
  })
  .strict();

export interface AgentDTO {
  id: string;
  revision: number;
  name: string;
  description: string;
  mission: "scout";
  wallet: string | null;
  walletVerifiedAt: string | null;
  visibility: "private" | "public";
  publishedAt: string | null;
  reportPolicy: "public" | "token-holders";
  gateMint: string | null;
  gateMinRaw: string | null;
  gateMaxAgeS: number;
  launch: null;
  createdAt: string;
  updatedAt: string;
}

/** Anonymous passport: only explicitly published fields. */
export interface PublicPassportDTO {
  id: string;
  name: string;
  description: string;
  mission: "scout";
  wallet: string;
  walletVerifiedAt: string;
  publishedAt: string;
  revision: number;
  reportPolicy: "public" | "token-holders";
  gateMint: string | null;
  gateMinRaw: string | null;
  metadata: { digest: string; version: number; publishedAt: string }[];
}
const PUBLIC_KEYS = ["id", "name", "description", "mission", "wallet", "walletVerifiedAt", "publishedAt", "revision", "reportPolicy", "gateMint", "gateMinRaw", "metadata"] as const;
export function sanitizePassport(raw: unknown): PublicPassportDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) out[k] = r[k] ?? null;
  out["metadata"] = Array.isArray(r["metadata"])
    ? (r["metadata"] as Record<string, unknown>[]).map((m) => ({ digest: m["digest"], version: m["version"], publishedAt: m["publishedAt"] }))
    : [];
  return out as unknown as PublicPassportDTO;
}

export interface ScoutQuoteFact {
  direction: "x-to-y" | "y-to-x";
  inputRaw: string;
  status: "quoted" | "unavailable";
  consumedRaw: string | null;
  outputRaw: string | null;
  lpFeeRaw: string | null;
  protocolFeeRaw: string | null;
  reason: string | null;
}
export interface ScoutFacts {
  v: 1;
  source: "studio-loco-conductor-adapter";
  pool: string;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number;
  slot: number;
  chainTime: number;
  observedAt: number;
  readMs: number;
  activeId: number;
  enabled: boolean;
  activated: boolean;
  referencePriceQ64: string;
  binArrays: string[];
  quotes: ScoutQuoteFact[];
  gaps: string[];
}
export interface ScoutAi {
  status: "ok" | "failed" | "rejected";
  model: string | null;
  brief: string | null;
  reason: string | null;
}
export interface ScoutReportDTO {
  id: string;
  agentId: string;
  createdAt: string;
  facts: ScoutFacts;
  ai: ScoutAi | null;
}

/** Depot transport contracts. Client-safe: no SDK, no secrets. All raw integers are decimal strings. */
import { z } from "zod";
import bs58 from "bs58";

/** Real base58 that decodes to exactly 32 bytes (a regex alone accepts invalid keys). */
export function isAddress32(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}
export const Address = z.string().refine(isAddress32, "Invalid Solana address");
export const Signature = z.string().refine((s) => {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s) && bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}, "Invalid transaction signature");
export const GATE_MAX_AGE_S = 60;
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
    gateMaxAgeS: z.number().int().min(10).max(GATE_MAX_AGE_S).optional(),
  })
  .strict();

export const ChallengeInput = z.object({ agentId: Uuid, wallet: Address, purpose: z.enum(PROOF_PURPOSES) }).strict();
export const VerifyInput = z
  .object({
    agentId: Uuid,
    wallet: Address,
    purpose: z.enum(PROOF_PURPOSES),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
    signature: Signature,
  })
  .strict();

export const PublishInput = z.object({ id: Uuid, revision: z.number().int().min(1), publish: z.boolean() }).strict();

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 262_144;
export const MetadataWebsite = z.string().trim().max(512).url("Use a complete HTTPS website URL")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  }, "Use an HTTPS website URL without a username or password")
  .transform((value) => new URL(value).href);

/** Accept a handle or a profile URL, never an arbitrary site, post or redirect. */
export function normalizeMetadataX(input: string): string | null {
  const value = input.trim();
  let handle: string;
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(value)) handle = value.replace(/^@/, "");
  else {
    try {
      const url = new URL(/^(?:www\.)?(?:x|twitter)\.com\//i.test(value) ? `https://${value}` : value);
      if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash) return null;
      const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
      if (!match) return null;
      handle = match[1]!;
    } catch { return null; }
  }
  if (["home", "explore", "search", "messages", "notifications", "settings", "login", "logout", "signup", "intent", "share", "compose", "i"].includes(handle.toLowerCase())) return null;
  return `https://x.com/${handle}`;
}
export const MetadataXProfile = z.string().trim().max(256).transform((value, ctx) => {
  const url = normalizeMetadataX(value);
  if (url) return url;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use an X profile URL or @handle" });
  return z.NEVER;
});
export const MetadataInput = z
  .object({
    agentId: Uuid,
    name: z.string().trim().min(1).max(32).refine((s) => new TextEncoder().encode(s).length <= 32, "Name max 32 bytes"),
    symbol: z.string().regex(/^[A-Z0-9]{1,10}$/, "Symbol 1–10 uppercase letters/digits"),
    description: z.string().trim().max(500),
    website: MetadataWebsite.optional(),
    xUrl: MetadataXProfile.optional(),
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
  launch: LaunchDTO | null;
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
  launch: LaunchDTO | null;
  metadata: { digest: string; version: number; publishedAt: string }[];
}
const PUBLIC_KEYS = ["id", "name", "description", "mission", "wallet", "walletVerifiedAt", "publishedAt", "revision", "reportPolicy", "gateMint", "gateMinRaw", "launch", "metadata"] as const;
export function sanitizePassport(raw: unknown): PublicPassportDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) out[k] = r[k] ?? null;
  out["metadata"] = Array.isArray(r["metadata"])
    ? (r["metadata"] as Record<string, unknown>[]).map((m) => ({ digest: m["digest"], version: m["version"], publishedAt: m["publishedAt"] }))
    : [];
  out["launch"] = parseLaunch(r["launch"]);
  return out as unknown as PublicPassportDTO;
}

/** Server-verified launch identity. Only these fields are ever stored or published. */
export const LaunchSchema = z
  .object({
    cluster: z.literal("mainnet-beta"),
    config: Address,
    mint: Address,
    pool: Address,
    signature: Signature,
    slot: z.number().int().nonnegative(),
    presetId: z.string().regex(/^[a-z0-9-]{1,40}$/),
    presetVersion: z.number().int().min(1),
    metadataDigest: z.string().regex(/^[0-9a-f]{64}$/),
    verifiedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LaunchDTO = z.infer<typeof LaunchSchema>;
export function parseLaunch(raw: unknown): LaunchDTO | null {
  const r = LaunchSchema.safeParse(raw);
  return r.success ? r.data : null;
}
export const RecordLaunchInput = z
  .object({
    agentId: Uuid,
    revision: z.number().int().min(1),
    config: Address,
    mint: Address,
    pool: Address,
    signature: Signature,
    metadataDigest: z.string().regex(/^[0-9a-f]{64}$/),
    presetId: z.string().max(40),
    presetVersion: z.number().int().min(1),
  })
  .strict();

export interface TokenMetadataDTO {
  digest: string;
  version: number;
  publishedAt: string;
  uri: string;
  imageUri: string;
  name: string;
  symbol: string;
  description: string;
  body: string;
  website?: string;
  xUrl?: string;
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
/** AI output is qualitative commentary tied to known fact IDs; it carries no numbers and no authority. */
export interface ScoutAiObservation {
  factId: string;
  note: string;
}
export interface ScoutAi {
  status: "ok" | "failed" | "rejected";
  model: string | null;
  brief: string | null;
  observations?: ScoutAiObservation[];
  reason: string | null;
}
export interface ScoutReportDTO {
  id: string;
  agentId: string;
  createdAt: string;
  facts: ScoutFacts;
  ai: ScoutAi | null;
}

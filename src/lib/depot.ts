/**
 * The Depot — pure deterministic core (no SDK, no network, no signing).
 * Launch presets, exact raw-unit launch math, visible recipient roles, review binding/expiry,
 * wallet-control challenge format, token-gate thresholds and AI-brief factuality checks.
 * Chain composition (DBC / DAMM v2 SDKs) is NOT implemented here and must stay separate.
 */
import bs58 from "bs58";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const DEPOT_REVIEW_TTL_MS = 20_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface LaunchPreset {
  id: string;
  version: number;
  label: string;
  quoteMint: string;
  tokenDecimals: number;
  /** Whole-token fixed supply; raw supply = supply * 10^decimals. */
  totalSupplyTokens: bigint;
  /** Nominal curve allocation. Actual migration amounts are derived by the SDK. */
  curveSupplyBps: number;
  /** Migration threshold in raw quote units (lamports for SOL). */
  migrationQuoteThresholdRaw: bigint;
  /** Total curve fee. Protocol takes 20%; creator share splits the remaining 80%. */
  tradingFeeBps: number;
  creatorFeeShareBps: number;
  /** Share of migrated LP that is permanently locked (bps). */
  lockedLpBps: number;
  migrationTarget: "damm-v2";
}

export const LAUNCH_PRESETS: readonly LaunchPreset[] = [
  {
    id: "standard-sol-85",
    version: 1,
    label: "Standard SPL / SOL — 85 SOL migration",
    quoteMint: WSOL_MINT,
    tokenDecimals: 6,
    totalSupplyTokens: 1_000_000_000n,
    curveSupplyBps: 8_000,
    migrationQuoteThresholdRaw: 85_000_000_000n,
    tradingFeeBps: 100,
    creatorFeeShareBps: 10_000,
    lockedLpBps: 10_000,
    migrationTarget: "damm-v2",
  },
  {
    id: "small-sol-20",
    version: 1,
    label: "Small SPL / SOL — 20 SOL migration",
    quoteMint: WSOL_MINT,
    tokenDecimals: 6,
    totalSupplyTokens: 100_000_000n,
    curveSupplyBps: 8_000,
    migrationQuoteThresholdRaw: 20_000_000_000n,
    tradingFeeBps: 100,
    creatorFeeShareBps: 10_000,
    lockedLpBps: 10_000,
    migrationTarget: "damm-v2",
  },
];
for (const p of LAUNCH_PRESETS) Object.freeze(p);
Object.freeze(LAUNCH_PRESETS);

export function getPreset(id: string, version: number): LaunchPreset {
  const p = LAUNCH_PRESETS.find((x) => x.id === id && x.version === version);
  if (!p) throw new Error(`Unknown launch preset ${id}@${version}`);
  return p;
}

const BPS = 10_000n;

export interface LaunchMath {
  rawSupply: bigint;
  curveRaw: bigint;
  migrationRaw: bigint;
  creatorFeeBps: number;
  protocolFeeBps: number;
  partnerFeeBps: number;
  /** Compatibility name; this is the partner share, not a Studio Loco charge. */
  platformFeeBps: number;
  lockedLpBps: number;
  unlockedLpBps: number;
}

/** Exact nominal supply allocation; fee percentages are rational, without flooring. */
export function launchMath(p: LaunchPreset): LaunchMath {
  if (!Number.isInteger(p.tokenDecimals) || p.tokenDecimals < 6 || p.tokenDecimals > 9)
    throw new Error("DBC decimals must be an integer 6–9");
  for (const b of [p.curveSupplyBps, p.creatorFeeShareBps, p.lockedLpBps, p.tradingFeeBps])
    if (!Number.isInteger(b) || b < 0 || b > 10_000) throw new Error("Basis points out of range");
  if (p.totalSupplyTokens <= 0n) throw new Error("Supply must be positive");
  if (p.migrationQuoteThresholdRaw <= 0n || p.curveSupplyBps <= 0 || p.curveSupplyBps >= 10_000)
    throw new Error("Migration needs a positive quote threshold and both token allocations");
  if (p.migrationTarget !== "damm-v2" || p.quoteMint !== WSOL_MINT || p.lockedLpBps !== 10_000)
    throw new Error("This release supports SOL-quoted DAMM v2 launches with permanently locked LP");
  const rawSupply = p.totalSupplyTokens * 10n ** BigInt(p.tokenDecimals);
  if (rawSupply > 18_446_744_073_709_551_615n) throw new Error("Raw supply exceeds u64");
  const curveRaw = (rawSupply * BigInt(p.curveSupplyBps)) / BPS;
  const protocolFeeBps = p.tradingFeeBps / 5;
  const creatorFeeBps = (p.tradingFeeBps - protocolFeeBps) * p.creatorFeeShareBps / 10_000;
  const partnerFeeBps = p.tradingFeeBps - protocolFeeBps - creatorFeeBps;
  return {
    rawSupply,
    curveRaw,
    migrationRaw: rawSupply - curveRaw,
    creatorFeeBps,
    protocolFeeBps,
    partnerFeeBps,
    platformFeeBps: partnerFeeBps,
    lockedLpBps: p.lockedLpBps,
    unlockedLpBps: 10_000 - p.lockedLpBps,
  };
}

/* ---------------- metadata ---------------- */

export interface TokenMetadataDraft {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  metadataUri: string;
}

export function validateMetadata(m: TokenMetadataDraft, allowedOrigin: string): string[] {
  const errs: string[] = [];
  if (!m.name.trim() || new TextEncoder().encode(m.name).length > 32) errs.push("Name must be 1–32 bytes");
  if (!/^[A-Z0-9]{1,10}$/.test(m.symbol)) errs.push("Symbol must be 1–10 uppercase letters/digits");
  if (m.description.length > 500) errs.push("Description max 500 characters");
  for (const [k, u] of [["Image", m.imageUrl], ["Metadata URI", m.metadataUri]] as const) {
    let url: URL | null = null;
    try {
      url = new URL(u);
    } catch {
      /* invalid */
    }
    if (!url || url.protocol !== "https:" || url.origin !== allowedOrigin)
      errs.push(`${k} must be a durable https URL on the project's public storage`);
    else if (url.search || url.hash || url.username || url.password)
      errs.push(`${k} must have no credentials, query string or fragment`);
    if (new TextEncoder().encode(u).length > 200) errs.push(`${k} max 200 bytes`);
  }
  return errs;
}

/* ---------------- recipients & review ---------------- */

export type RecipientRole =
  | "payer"
  | "creator"
  | "fee-claimer"
  | "leftover-receiver"
  | "partner"
  | "locked-lp-owner"
  | "unlocked-lp-owner";

export interface Recipient {
  role: RecipientRole;
  address: string;
}

export function isDepotAddress(s: string): boolean {
  try { return bs58.decode(s).length === 32; } catch { return false; }
}

/** Every economic role must be explicit, valid base58, and creator-side roles must equal the owner wallet. */
export function validateRecipients(owner: string, rs: Recipient[], m: LaunchMath): string[] {
  const errs: string[] = [];
  if (!isDepotAddress(owner)) errs.push("Invalid owner wallet");
  const need: RecipientRole[] = ["payer", "creator", "fee-claimer", "leftover-receiver"];
  if (m.lockedLpBps > 0) need.push("locked-lp-owner");
  if (m.unlockedLpBps > 0) need.push("unlocked-lp-owner");
  if (m.platformFeeBps > 0) need.push("partner");
  for (const r of need) if (!rs.some((x) => x.role === r)) errs.push(`Missing recipient: ${r}`);
  const seen = new Set<string>();
  for (const r of rs) {
    if (seen.has(r.role)) errs.push(`Duplicate recipient role: ${r.role}`);
    seen.add(r.role);
    if (!isDepotAddress(r.address)) errs.push(`Invalid address for ${r.role}`);
    if (r.address !== owner)
      errs.push(`${r.role} must be the connected owner wallet`);
  }
  return errs;
}

export interface ReviewBinding {
  wallet: string;
  cluster: string;
  rpc: "relay" | "custom" | "public";
  /** In-memory generation for the exact connection identity; never persist a secret RPC URL. */
  rpcGeneration?: number;
  agentId: string;
  agentRevision: number;
  presetId: string;
  presetVersion: number;
  metadataUri: string;
  metadataHash?: string;
  recipients: Recipient[];
  maxStageLamports: bigint;
  maxTotalLamports: bigint;
}

export function bindingKey(b: ReviewBinding): string {
  const rs = [...b.recipients].sort((a, c) => a.role.localeCompare(c.role));
  return JSON.stringify([
    b.wallet, b.cluster, b.rpc, b.rpcGeneration ?? 0, b.agentId, b.agentRevision, b.presetId, b.presetVersion,
    b.metadataUri, b.metadataHash ?? "", rs.map((r) => [r.role, r.address]),
    b.maxStageLamports.toString(), b.maxTotalLamports.toString(),
  ]);
}

export interface PreparedReview {
  key: string;
  createdAt: number;
  stages: { label: string; feeLamports: bigint | null; rentLamports: bigint | null }[];
}

/** Returns a refusal reason, or null when the review may proceed to signing. */
export function reviewGuard(r: PreparedReview, current: ReviewBinding, now: number, b: ReviewBinding): string | null {
  if (r.key !== bindingKey(current) || bindingKey(current) !== bindingKey(b)) return "Launch inputs changed since review; prepare again.";
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(r.createdAt) || now < r.createdAt || now - r.createdAt > DEPOT_REVIEW_TTL_MS) return "Review expired; prepare again.";
  if (current.maxStageLamports <= 0n || current.maxTotalLamports <= 0n || !r.stages.length)
    return "Positive cost caps and a prepared stage are required.";
  let total = 0n;
  for (const s of r.stages) {
    if (s.feeLamports === null || s.rentLamports === null)
      return `Cost unknown for ${s.label}; nothing will be signed.`;
    if (s.feeLamports < 0n || s.rentLamports < 0n) return "Invalid negative cost.";
    const c = s.feeLamports + s.rentLamports;
    if (c > b.maxStageLamports) return `${s.label} costs ${c} lamports, above the stage cap.`;
    total += c;
  }
  if (total > b.maxTotalLamports) return `Total cost ${total} lamports exceeds the total cap.`;
  return null;
}

/* ---------------- wallet-control challenge ---------------- */

export interface Challenge {
  domain: string;
  agentId: string;
  wallet: string;
  nonce: string;
  issuedAt: number;
}

export function challengeMessage(c: Challenge): string {
  return [
    `${c.domain} wants you to prove control of this Solana wallet for a Studio Loco Depot agent.`,
    `Wallet: ${c.wallet}`,
    `Agent: ${c.agentId}`,
    `Nonce: ${c.nonce}`,
    `Issued: ${new Date(c.issuedAt).toISOString()}`,
    "This signature does not authorize any transaction or transfer of funds.",
  ].join("\n");
}

/** Server-side acceptance rules (signature verification itself is ed25519, done by the caller). */
export function challengeGuard(
  c: Challenge,
  expect: { domain: string; agentId: string; wallet: string },
  usedNonces: ReadonlySet<string>,
  now: number,
): string | null {
  if (c.domain !== expect.domain) return "Wrong domain";
  if (c.agentId !== expect.agentId) return "Wrong agent";
  if (c.wallet !== expect.wallet) return "Wrong wallet";
  if (!/^[0-9a-f]{32,64}$/.test(c.nonce)) return "Malformed nonce";
  if (usedNonces.has(c.nonce)) return "Nonce already used";
  if (now < c.issuedAt || now - c.issuedAt > CHALLENGE_TTL_MS) return "Challenge expired";
  return null;
}

/* ---------------- token gate ---------------- */

export function tokenGate(
  policy: { mode: "public" } | { mode: "holders"; mint: string; minRaw: bigint; maxAgeMs: number },
  read: { mint: string; rawBalance: bigint; readAt: number; walletVerified: boolean } | null,
  now: number,
): { allowed: boolean; reason: string } {
  if (policy.mode === "public") return { allowed: true, reason: "Public report" };
  if (!isDepotAddress(policy.mint) || policy.minRaw <= 0n || !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0 || policy.maxAgeMs > 60_000)
    return { allowed: false, reason: "Invalid holder policy" };
  if (!read) return { allowed: false, reason: "Balance unavailable" };
  if (!read.walletVerified) return { allowed: false, reason: "Wallet control not verified" };
  if (read.mint !== policy.mint) return { allowed: false, reason: "Wrong mint" };
  if (!Number.isSafeInteger(read.readAt) || read.readAt > now || now - read.readAt > policy.maxAgeMs || read.rawBalance < 0n) return { allowed: false, reason: "Balance read is stale" };
  if (read.rawBalance < policy.minRaw) return { allowed: false, reason: "Below holder threshold" };
  return { allowed: true, reason: "Holder threshold met" };
}

/* ---------------- Scout AI brief factuality ---------------- */

/** Every number in the AI brief must appear verbatim in the observed fact strings. */
export function briefFactualityIssues(brief: string, facts: string[]): string[] {
  const corpus = facts.join(" ");
  const nums = brief.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const issues = nums.filter((n) => !corpus.includes(n)).map((n) => `Unsupported number: ${n}`);
  if (/\b(guarantee|apy|profit|will earn|sign|send transaction)\b/i.test(brief))
    issues.push("Brief contains forbidden claims or actions");
  return issues;
}

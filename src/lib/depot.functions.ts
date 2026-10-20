import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  AgentDraftInput,
  AgentUpdateInput,
  ChallengeInput,
  MetadataInput,
  PROOF_TTL_MS,
  PublishInput,
  ScoutInput,
  Uuid,
  VerifyInput,
  proofMessage,
  sanitizePassport,
  type AgentDTO,
  type ProofChallenge,
  type ScoutReportDTO,
} from "./depot-contracts";

type AgentRow = Database["public"]["Tables"]["depot_agents"]["Row"];
const err = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/[^\s"')]+/g, "[url]").slice(0, 300);

async function admin() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}
async function srv() {
  return import("./depot.server");
}
function toDTO(r: AgentRow): AgentDTO {
  return {
    id: r.id, revision: r.revision, name: r.name, description: r.description, mission: "scout",
    wallet: r.wallet, walletVerifiedAt: r.wallet_verified_at,
    visibility: r.visibility as AgentDTO["visibility"], publishedAt: r.published_at,
    reportPolicy: r.report_policy as AgentDTO["reportPolicy"],
    gateMint: r.gate_mint, gateMinRaw: r.gate_min_raw, gateMaxAgeS: r.gate_max_age_s,
    launch: null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
/** Server-side ownership check through the caller's RLS-scoped client. */
async function ownAgent(supabase: { from: (t: "depot_agents") => any }, id: string): Promise<AgentRow> {
  const { data, error } = await supabase.from("depot_agents").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Agent not found.");
  return data as AgentRow;
}
async function publicClient() {
  const { createClient } = await import("@supabase/supabase-js");
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}
async function mainnet() {
  const { mainnetConnection } = await import("./signal-worker.server");
  return mainnetConnection();
}

/* ---------------- agent CRUD ---------------- */

export const listMyAgents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("depot_agents").select("*").order("created_at", { ascending: false }).limit(50);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, agents: (data as AgentRow[]).map(toDTO) };
  });

export const createAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AgentDraftInput.parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { count } = await a.from("depot_agents").select("id", { count: "exact", head: true }).eq("user_id", context.userId);
    if ((count ?? 0) >= 10) return { ok: false as const, error: "Agent limit reached (10)." };
    const { data: row, error } = await a
      .from("depot_agents")
      .insert({ user_id: context.userId, name: data.name, description: data.description, mission: "scout" })
      .select("*")
      .single();
    return error ? { ok: false as const, error: error.message } : { ok: true as const, agent: toDTO(row) };
  });

export const updateAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AgentUpdateInput.parse(d))
  .handler(async ({ data, context }) => {
    try {
      const cur = await ownAgent(context.supabase, data.id);
      const next = {
        name: data.name ?? cur.name,
        description: data.description ?? cur.description,
        report_policy: data.reportPolicy ?? cur.report_policy,
        gate_mint: data.gateMint === undefined ? cur.gate_mint : data.gateMint,
        gate_min_raw: data.gateMinRaw === undefined ? cur.gate_min_raw : data.gateMinRaw,
        gate_max_age_s: data.gateMaxAgeS ?? cur.gate_max_age_s,
      };
      if (next.report_policy === "token-holders" && (!cur.wallet_verified_at || !next.gate_mint || !next.gate_min_raw))
        return { ok: false as const, error: "Holder-only reports need a verified agent wallet, a gate mint and a raw minimum." };
      const { data: rows, error } = await (await admin())
        .from("depot_agents")
        .update({ ...next, revision: cur.revision + 1, updated_at: new Date().toISOString() })
        .eq("id", data.id).eq("user_id", context.userId).eq("revision", data.revision)
        .select("*");
      if (error) return { ok: false as const, error: error.message };
      if (!rows?.length) return { ok: false as const, error: "Agent changed elsewhere; reload and retry.", stale: true };
      return { ok: true as const, agent: toDTO(rows[0]!) };
    } catch (e) {
      return { ok: false as const, error: err(e) };
    }
  });

/** Deletes the draft/passport and its reports. Published token metadata stays immutable and resolvable. */
export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: Uuid, revision: z.number().int().min(1) }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (await admin())
      .from("depot_agents").delete().eq("id", data.id).eq("user_id", context.userId).eq("revision", data.revision).select("id");
    if (error) return { ok: false as const, error: error.message };
    return rows?.length ? { ok: true as const } : { ok: false as const, error: "Agent changed elsewhere or not found.", stale: true };
  });

/* ---------------- wallet proof ---------------- */

export const requestWalletChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ChallengeInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await srv();
    const domain = s.proofDomain(getRequestHeader("host"));
    if (!domain) return { ok: false as const, error: "This site address is not allowed to request wallet proofs." };
    const a = await admin();
    try {
      const agent = await ownAgent(context.supabase, data.agentId);
      if (data.purpose === "viewer" && agent.user_id === context.userId && false) void 0;
      if (data.purpose === "controller" && agent.user_id !== context.userId) throw new Error("Agent not found.");
    } catch (e) {
      // Viewers prove a wallet for someone else's public agent.
      if (data.purpose === "controller") return { ok: false as const, error: err(e) };
      const { data: pub } = await (await publicClient()).rpc("depot_public_passport", { _id: data.agentId });
      if (!pub) return { ok: false as const, error: "Agent not found." };
    }
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const { count } = await a.from("depot_nonces").select("nonce", { count: "exact", head: true }).eq("user_id", context.userId).gte("issued_at", since);
    if ((count ?? 0) >= 10) return { ok: false as const, error: "Too many proof requests; wait a few minutes." };
    const now = new Date();
    const c: ProofChallenge = {
      domain, purpose: data.purpose, agentId: data.agentId, wallet: data.wallet, nonce: s.randomNonce(),
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + PROOF_TTL_MS).toISOString(),
    };
    const { error } = await a.from("depot_nonces").insert({
      nonce: c.nonce, user_id: context.userId, agent_id: c.agentId, wallet: c.wallet, purpose: c.purpose,
      domain, issued_at: c.issuedAt, expires_at: c.expiresAt,
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, challenge: c, message: proofMessage(c) };
  });

export const verifyWalletChallenge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => VerifyInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await srv();
    const domain = s.proofDomain(getRequestHeader("host"));
    if (!domain) return { ok: false as const, error: "Wrong site address for this proof." };
    const a = await admin();
    const { data: n } = await a.from("depot_nonces").select("*").eq("nonce", data.nonce).maybeSingle();
    if (!n || n.user_id !== context.userId || n.agent_id !== data.agentId || n.wallet !== data.wallet || n.purpose !== data.purpose || n.domain !== domain)
      return { ok: false as const, error: "Proof does not match this session, agent, wallet or site." };
    if (n.consumed_at) return { ok: false as const, error: "This proof was already used." };
    const now = Date.now();
    if (Date.parse(n.issued_at) > now + 5_000 || Date.parse(n.expires_at) <= now) return { ok: false as const, error: "Proof expired; request a new one." };
    const message = proofMessage({
      domain: n.domain, purpose: n.purpose as ProofChallenge["purpose"], agentId: n.agent_id, wallet: n.wallet,
      nonce: n.nonce, issuedAt: new Date(n.issued_at).toISOString(), expiresAt: new Date(n.expires_at).toISOString(),
    });
    if (!s.verifyWalletSignature(message, data.signature, data.wallet)) return { ok: false as const, error: "Signature is not valid for this wallet and message." };
    const { data: consumed, error } = await a.rpc("depot_consume_nonce", {
      _nonce: n.nonce, _user: context.userId, _agent: n.agent_id, _wallet: n.wallet, _purpose: n.purpose, _domain: n.domain,
    });
    if (error) return { ok: false as const, error: err(error.message) };
    return consumed ? { ok: true as const, wallet: n.wallet, purpose: n.purpose } : { ok: false as const, error: "Proof already used or expired." };
  });

/* ---------------- publication ---------------- */

export const setPassportPublished = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PublishInput.parse(d))
  .handler(async ({ data, context }) => {
    try {
      const cur = await ownAgent(context.supabase, data.id);
      if (data.publish && !cur.wallet_verified_at) return { ok: false as const, error: "Prove control of the agent wallet before publishing." };
      const { data: rows, error } = await (await admin())
        .from("depot_agents")
        .update({
          visibility: data.publish ? "public" : "private",
          published_at: data.publish ? new Date().toISOString() : null,
          revision: cur.revision + 1, updated_at: new Date().toISOString(),
        })
        .eq("id", data.id).eq("user_id", context.userId).eq("revision", data.revision).select("*");
      if (error) return { ok: false as const, error: error.message };
      return rows?.length ? { ok: true as const, agent: toDTO(rows[0]!) } : { ok: false as const, error: "Agent changed elsewhere; reload.", stale: true };
    } catch (e) {
      return { ok: false as const, error: err(e) };
    }
  });

/** Anonymous passport read: whitelisted published fields only. */
export const getPublicPassport = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ id: Uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    const { data: raw, error } = await (await publicClient()).rpc("depot_public_passport", { _id: data.id });
    if (error) return { ok: false as const, error: "Passport unavailable." };
    const p = sanitizePassport(raw);
    return p ? { ok: true as const, passport: p } : { ok: false as const, error: "No published passport with this id." };
  });

/* ---------------- metadata ---------------- */

export const publishTokenMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => MetadataInput.parse(d))
  .handler(async ({ data, context }) => {
    const s = await srv();
    const domain = s.proofDomain(getRequestHeader("host"));
    if (!domain || domain.startsWith("localhost")) return { ok: false as const, error: "Metadata can only be published from the public HTTPS site." };
    try {
      const agent = await ownAgent(context.supabase, data.agentId);
      if (!agent.wallet_verified_at) return { ok: false as const, error: "Prove control of the agent wallet first." };
      const bytes = s.decodeImage(data.imageBase64, data.imageMime);
      const imageDigest = s.sha256Hex(bytes);
      const { body, digest } = s.buildMetadataBody({ name: data.name, symbol: data.symbol, description: data.description, image: s.imageUri(domain, imageDigest) });
      const uri = s.metadataUri(domain, digest);
      if (new TextEncoder().encode(uri).length > 200) return { ok: false as const, error: "Metadata URI too long." };
      const a = await admin();
      const { error: ie } = await a.from("depot_images").upsert(
        { digest: imageDigest, user_id: context.userId, mime: data.imageMime, bytes: `\\x${s.hex(bytes)}` as never },
        { onConflict: "digest", ignoreDuplicates: true },
      );
      if (ie) return { ok: false as const, error: ie.message };
      const { data: existing } = await a.from("depot_metadata").select("digest,version,published_at").eq("digest", digest).maybeSingle();
      if (existing) return { ok: true as const, digest, uri, version: existing.version, publishedAt: existing.published_at, immutable: true, reused: true, cost: "free; no on-chain cost until a launch uses this URI" };
      const { data: last } = await a.from("depot_metadata").select("version").eq("agent_id", agent.id).order("version", { ascending: false }).limit(1);
      const version = (last?.[0]?.version ?? 0) + 1;
      const { data: row, error } = await a.from("depot_metadata").insert({ digest, user_id: context.userId, agent_id: agent.id, version, body, image_digest: imageDigest }).select("published_at").single();
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, digest, uri, version, publishedAt: row.published_at, immutable: true, reused: false, cost: "free; no on-chain cost until a launch uses this URI" };
    } catch (e) {
      return { ok: false as const, error: err(e) };
    }
  });

/* ---------------- Scout ---------------- */

export const runScoutReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ScoutInput.parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    let agent: AgentRow;
    try {
      agent = await ownAgent(context.supabase, data.agentId);
    } catch (e) {
      return { ok: false as const, error: err(e) };
    }
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { data: recent } = await a.from("depot_reports").select("ai").eq("user_id", context.userId).gte("created_at", hourAgo);
    if ((recent?.length ?? 0) >= 20) return { ok: false as const, error: "Report limit reached (20 per hour)." };
    const aiUsed = (recent ?? []).filter((r) => r.ai !== null).length;
    const s = await srv();
    const { JobControl } = await import("./job-control");
    const { readConductorSnapshot } = await import("./conductor-chain");
    const ctl = new JobControl(), job = ctl.begin()!;
    const t0 = Date.now();
    let facts;
    try {
      const snap = await readConductorSnapshot(
        await mainnet(),
        { pool: data.pool, owner: agent.wallet ?? "11111111111111111111111111111111", probesX: data.probesX, probesY: data.probesY },
        job, "server",
      );
      facts = s.scoutFacts(snap, Date.now() - t0);
    } catch (e) {
      return { ok: false as const, error: `Market read failed: ${err(e)}` };
    } finally {
      ctl.unmount();
      ctl.end(job);
    }
    let ai = null;
    if (data.withAi)
      ai = aiUsed >= 5 ? { status: "failed" as const, model: null, brief: null, reason: "AI brief limit reached (5 per hour)." } : await s.scoutBrief(facts, process.env["LOVABLE_API_KEY"]);
    const { data: row, error } = await a
      .from("depot_reports")
      .insert({ user_id: context.userId, agent_id: agent.id, pool: facts.pool, slot: facts.slot, observed_at: new Date(facts.observedAt).toISOString(), facts: facts as never, ai: ai as never })
      .select("id,created_at").single();
    if (error) return { ok: false as const, error: error.message };
    const report: ScoutReportDTO = { id: row.id, agentId: agent.id, createdAt: row.created_at, facts, ai };
    return { ok: true as const, report };
  });

export const listMyReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agentId: Uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.from("depot_reports").select("id,agent_id,created_at,facts,ai").eq("agent_id", data.agentId).order("created_at", { ascending: false }).limit(20);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, reports: rows.map((r) => ({ id: r.id, agentId: r.agent_id, createdAt: r.created_at, facts: r.facts, ai: r.ai }) as unknown as ScoutReportDTO) };
  });

/** Anonymous: only for public agents whose policy is "public". */
export const listPublicReports = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ agentId: Uuid }).strict().parse(d))
  .handler(async ({ data }) => {
    const { data: raw, error } = await (await publicClient()).rpc("depot_public_reports", { _agent: data.agentId });
    if (error) return { ok: false as const, error: "Reports unavailable." };
    return { ok: true as const, reports: (raw ?? []) as unknown as ScoutReportDTO[] };
  });

/** Holder-only reports: fresh server-side balance of the caller's PROVEN viewer wallet. */
export const listGatedReports = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agentId: Uuid }).strict().parse(d))
  .handler(async ({ data, context }) => {
    const a = await admin();
    const { data: agent } = await a.from("depot_agents").select("*").eq("id", data.agentId).maybeSingle();
    if (!agent || agent.visibility !== "public" || agent.report_policy !== "token-holders")
      return { ok: false as const, error: "No holder-only reports for this agent." };
    const { data: viewer } = await context.supabase.from("depot_viewer_wallets").select("wallet").eq("agent_id", data.agentId).maybeSingle();
    if (!viewer) return { ok: false as const, error: "Prove control of a holder wallet first.", needsProof: true };
    const s = await srv();
    let read = null;
    try {
      read = await s.readTokenBalance(await mainnet(), viewer.wallet, agent.gate_mint!);
    } catch (e) {
      return { ok: false as const, error: `Balance unavailable: ${err(e)}` };
    }
    const d = s.gateDecision(agent, read, true);
    if (!d.allowed) return { ok: false as const, error: d.reason, balanceRaw: read.rawBalance.toString(), slot: read.slot };
    const { data: rows, error } = await a.from("depot_reports").select("id,agent_id,created_at,facts,ai").eq("agent_id", data.agentId).order("created_at", { ascending: false }).limit(20);
    if (error) return { ok: false as const, error: error.message };
    return {
      ok: true as const, balanceRaw: read.rawBalance.toString(), slot: read.slot, wallet: viewer.wallet,
      reports: rows.map((r) => ({ id: r.id, agentId: r.agent_id, createdAt: r.created_at, facts: r.facts, ai: r.ai }) as unknown as ScoutReportDTO),
    };
  });

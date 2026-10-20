// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/depot.server";
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => { const builder: any = { middleware: () => builder, inputValidator: () => builder, handler: (h: unknown) => h }; return builder; } }));
vi.mock("@/lib/depot-auth.middleware", () => ({ requireDepotWalletAuth: {} }));
import { listMyAgents, listMyReports, listMyTokenMetadata, updateAgent } from "@/lib/depot.functions";
const A = "00000000-0000-4000-8000-000000000011", B = "00000000-0000-4000-8000-000000000012";
function client() {
  const rows = [A, B].map((user_id, i) => { const body = JSON.stringify({ name: `user-${i}`, symbol: "QA", image: `https://studioloco.cfd/api/public/depot/image/${"a".repeat(64)}` }); return ({ digest: sha256Hex(new TextEncoder().encode(body)), version: 1, published_at: new Date().toISOString(), user_id, id: `agent-${i}`, agent_id: "shared-id", name: user_id, revision: 1, launch: null, facts: {}, body }); });
  return { from: () => {
    const filters: [string, unknown][] = []; const result = () => rows.filter(r => filters.every(([k, v]) => r[k as keyof typeof r] === v));
    const q: any = { select: () => q, eq: (k: string, v: unknown) => { filters.push([k, v]); return q; }, order: () => q, limit: () => q, maybeSingle: async () => ({ data: result()[0] ?? null, error: null }), then: (resolve: (v: unknown) => void) => resolve({ data: result(), error: null }) }; return q;
  } };
}
const call = (fn: unknown, args: unknown) => (fn as (a: unknown) => Promise<any>)(args);
describe("wallet principal data isolation with a server-only database client", () => {
  it("lists only agents owned by the authenticated principal", async () => {
    const r = await call(listMyAgents, { context: { userId: A, supabase: client() } });
    expect(r.agents.map((a: any) => a.name)).toEqual([A]);
  });
  it("does not disclose another principal's reports even for a supplied agent id", async () => {
    const r = await call(listMyReports, { context: { userId: A, supabase: client() }, data: { agentId: "shared-id" } });
    expect(r.reports).toHaveLength(1);
  });
  it("cannot load another principal's agent for edits", async () => {
    const r = await call(updateAgent, { context: { userId: A, supabase: client() }, data: { id: "agent-1", revision: 1, name: "stolen" } });
    expect(r).toMatchObject({ ok: false, error: "Agent not found." });
  });
  it("does not offer foreign metadata for launching", async () => {
    const r = await call(listMyTokenMetadata, { context: { userId: A, supabase: client() }, data: { agentId: "shared-id" } });
    expect(r.metadata.map((m: any) => m.name)).toEqual(["user-0"]);
  });
});

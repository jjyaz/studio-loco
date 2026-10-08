import { describe, expect, it } from "vitest";
import {
  PLAN_SNAPSHOT_TTL_MS, comparisonFact, feeRecovery, mapToDestination, planIdentityKey, selectionFact, selectionRefusal,
  solTextToLamports, targetFor, validateWiden, type PlanIdentity, type PlanSnapshot,
} from "@/lib/planner";
import { RecordSchema, parseImport } from "@/lib/recorder";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const id: PlanIdentity = {
  mode: "wallet", owner: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD", cluster: "mainnet-beta", rpcId: "relay",
  position: "1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id", pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  strategy: "Spot", slippageBps: 50, ruleRevision: 2, watchRevision: null, widenLower: -5460, widenUpper: -5420, destPool: null,
};
const snap = (over: Partial<PlanSnapshot> = {}): PlanSnapshot => ({
  id: "plan-abcdef12", identityKey: planIdentityKey(id), identity: id, createdAt: 1_000_000, slot: 1, activeId: -5441,
  current: { lower: -5445, upper: -5400 }, mintX: SOL, mintY: USDC, decX: 9, decY: 6, assumptionLamportsPerDay: null,
  results: [
    { option: "keep", target: null, sim: "none", rentLamports: 0n },
    { option: "recenter", target: { lower: -5464, upper: -5419 }, sim: "sdk-ok", rentLamports: 72_000_000n, depositX: "1", depositY: "2" },
    { option: "widen", target: null, sim: "failed", rentLamports: null, reason: "SDK simulation failed: x" },
    { option: "move", target: { lower: 1, upper: 46 }, sim: "staged-verified", destPool: "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh", rentLamports: null },
  ],
  ...over,
});

describe("planner math", () => {
  it("recenter keeps the exact width around the active bin", () => {
    expect(targetFor("recenter", { lower: -5445, upper: -5400 }, -5441)).toEqual({ lower: -5464, upper: -5419 });
    expect(targetFor("keep", { lower: 0, upper: 9 }, 50)).toBeNull();
  });
  it("widen must be strictly wider and within 69 levels", () => {
    expect(validateWiden({ lower: 0, upper: 9 }, 0, 9).ok).toBe(false);
    expect(validateWiden({ lower: 0, upper: 9 }, -5, 14)).toEqual({ ok: true, range: { lower: -5, upper: 14 } });
    expect(validateWiden({ lower: 0, upper: 9 }, 0, 69).ok).toBe(false);
    expect(validateWiden({ lower: 0, upper: 9 }, 5, 1).ok).toBe(false);
  });
  it("reversed destination swaps amounts by mint address", () => {
    expect(mapToDestination({ mintX: SOL, mintY: USDC, x: "5", y: "7" }, { mintX: USDC, mintY: SOL })).toEqual({ x: "7", y: "5", orientation: "reversed" });
    expect(() => mapToDestination({ mintX: SOL, mintY: USDC, x: "5", y: "7" }, { mintX: SOL, mintY: SOL })).toThrow();
  });
  it("SOL text parses exactly", () => {
    expect(solTextToLamports("0.002")).toBe(2_000_000n);
    expect(solTextToLamports("1.0000000001")).toBeNull();
  });
  it("fee recovery only with a known cost and a user assumption", () => {
    expect(feeRecovery("keep", 0n, null).state).toBe("none");
    expect(feeRecovery("recenter", null, 1n).state).toBe("unavailable");
    expect(feeRecovery("recenter", 72_000_000n, null).state).toBe("unavailable");
    expect(feeRecovery("recenter", 72_000_000n, 2_000_000n)).toMatchObject({ state: "estimate", days: "36.0" });
    expect(feeRecovery("recenter", 1n, 3n)).toMatchObject({ days: "0.4" });
  });
});

describe("planner identity and expiry", () => {
  it("any identity input change invalidates selection", () => {
    for (const k of ["owner", "cluster", "rpcId", "slippageBps", "position", "widenLower", "watchRevision", "strategy"] as const) {
      const changed = planIdentityKey({ ...id, [k]: k === "watchRevision" ? 3 : k === "slippageBps" ? 51 : k === "widenLower" ? -5461 : "x" });
      expect(selectionRefusal(snap(), changed, "recenter", 1_000_001)).toMatch(/changed/);
    }
  });
  it("snapshots expire after 2 minutes", () => {
    expect(selectionRefusal(snap(), planIdentityKey(id), "recenter", 1_000_000 + PLAN_SNAPSHOT_TTL_MS)).toBeNull();
    expect(selectionRefusal(snap(), planIdentityKey(id), "recenter", 1_000_001 + PLAN_SNAPSHOT_TTL_MS)).toMatch(/older/);
  });
  it("watch-only, stay-put and failed simulations cannot reach review", () => {
    const w = { ...id, mode: "watch" as const };
    expect(selectionRefusal(snap({ identity: w, identityKey: planIdentityKey(w) }), planIdentityKey(w), "recenter", 1_000_001)).toMatch(/Watch-only/);
    expect(selectionRefusal(snap(), planIdentityKey(id), "keep", 1_000_001)).toMatch(/no transaction/);
    expect(selectionRefusal(snap(), planIdentityKey(id), "widen", 1_000_001)).toMatch(/failed/);
    expect(selectionRefusal(snap(), planIdentityKey(id), "move", 1_000_001)).toBeNull();
  });
});

describe("planner recorder facts", () => {
  const asRecord = (f: ReturnType<typeof comparisonFact>, rid: string) => ({
    v: 1, id: rid, kind: f.kind, provenance: "this-device", createdAt: 1, updatedAt: 1, route: f.route, cluster: f.cluster,
    rpc: "none", wallet: f.wallet, title: f.title, status: f.status, links: f.links, context: f.context, steps: [], timeline: [], postState: [],
  });
  it("comparison record is schema-valid, non-executable and URL-free", () => {
    const f = comparisonFact(snap({ identity: { ...id, rpcId: "custom-1234abcd" } }));
    expect(RecordSchema.safeParse(asRecord(f, "prop-12345678")).success).toBe(true);
    expect(f.context.executable).toBe(false);
    expect(f.context.rpcKind).toBe("custom");
    expect(JSON.stringify(f)).not.toMatch(/https?:|custom-1234abcd/);
    expect(f.links.proposalId).toBe("plan-abcdef12");
  });
  it("selection links back to its comparison and plan", () => {
    const f = selectionFact(snap(), "move", "prop-12345678");
    expect(f.links).toEqual({ proposalId: "plan-abcdef12", recordId: "prop-12345678" });
    expect(f.context.destPool).toBe("BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh");
  });
  it("imported plan evidence stays import provenance (never executable)", () => {
    const r = asRecord(comparisonFact(snap()), "prop-12345678");
    const out = parseImport({ v: 1, records: [r] });
    for (const rec of out.records) expect(rec.provenance).not.toBe("this-device");
  });
});

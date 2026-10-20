import { describe, expect, it } from "vitest";
import {
  bindingKey, briefFactualityIssues, challengeGuard, getPreset, launchMath, reviewGuard,
  tokenGate, validateMetadata, validateRecipients, type ReviewBinding,
} from "@/lib/depot";

const OWNER = "4SPWhu1111111111111111111111111111111111111";
const PARTNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("depot launch math", () => {
  it("allocates the exact raw supply", () => {
    const m = launchMath(getPreset("standard-sol-85", 1));
    expect(m.rawSupply).toBe(1_000_000_000_000_000n);
    expect(m.curveRaw + m.migrationRaw).toBe(m.rawSupply);
    expect(m.curveRaw).toBe(800_000_000_000_000n);
    expect(m.creatorFeeBps + m.platformFeeBps).toBe(100);
  });
});

describe("recipients", () => {
  const m = launchMath(getPreset("standard-sol-85", 1));
  const ok = [
    { role: "payer", address: OWNER }, { role: "creator", address: OWNER },
    { role: "fee-claimer", address: OWNER }, { role: "leftover-receiver", address: OWNER },
    { role: "locked-lp-owner", address: OWNER }, { role: "partner", address: PARTNER },
  ] as const;
  it("accepts explicit owner recipients", () => expect(validateRecipients(OWNER, [...ok], m)).toEqual([]));
  it("rejects a silently swapped creator", () => {
    const rs = ok.map((r) => (r.role === "creator" ? { ...r, address: PARTNER } : r));
    expect(validateRecipients(OWNER, rs, m)).toContain("creator must be the connected owner wallet");
  });
  it("requires a partner when platform fees exist", () =>
    expect(validateRecipients(OWNER, ok.filter((r) => r.role !== "partner"), m)).toContain("Missing recipient: partner"));
});

describe("review guard", () => {
  const b: ReviewBinding = {
    wallet: OWNER, cluster: "mainnet-beta", rpc: "relay", agentId: "a", agentRevision: 1,
    presetId: "standard-sol-85", presetVersion: 1, metadataUri: "https://x/m.json",
    recipients: [], maxStageLamports: 30_000_000n, maxTotalLamports: 50_000_000n,
  };
  const r = { key: bindingKey(b), createdAt: 0, stages: [{ label: "config", feeLamports: 5000n, rentLamports: 3_000_000n }] };
  it("passes when fresh and within caps", () => expect(reviewGuard(r, b, 1000, b)).toBeNull());
  it("refuses mutated inputs", () => expect(reviewGuard(r, { ...b, agentRevision: 2 }, 1000, b)).toMatch(/changed/));
  it("refuses after 20s", () => expect(reviewGuard(r, b, 20_001, b)).toMatch(/expired/));
  it("refuses unknown cost", () =>
    expect(reviewGuard({ ...r, stages: [{ label: "pool", feeLamports: null, rentLamports: 1n }] }, b, 1, b)).toMatch(/unknown/));
  it("refuses over total cap", () =>
    expect(reviewGuard({ ...r, stages: [r.stages[0]!, { label: "pool", feeLamports: 0n, rentLamports: 48_000_000n }] }, b, 1, b)).toMatch(/total cap/));
});

describe("wallet challenge", () => {
  const c = { domain: "studioloco.cfd", agentId: "a", wallet: OWNER, nonce: "a".repeat(32), issuedAt: 0 };
  const e = { domain: "studioloco.cfd", agentId: "a", wallet: OWNER };
  it("accepts once", () => expect(challengeGuard(c, e, new Set(), 1000)).toBeNull());
  it("rejects replay", () => expect(challengeGuard(c, e, new Set([c.nonce]), 1000)).toMatch(/used/));
  it("rejects wrong domain", () => expect(challengeGuard({ ...c, domain: "evil.io" }, e, new Set(), 1)).toMatch(/domain/));
  it("rejects expired", () => expect(challengeGuard(c, e, new Set(), 5 * 60_000 + 1)).toMatch(/expired/));
});

describe("token gate", () => {
  const p = { mode: "holders" as const, mint: "M", minRaw: 1_000_000n, maxAgeMs: 60_000 };
  it("allows at exact threshold", () =>
    expect(tokenGate(p, { mint: "M", rawBalance: 1_000_000n, readAt: 0, walletVerified: true }, 1).allowed).toBe(true));
  it("denies one raw unit below", () =>
    expect(tokenGate(p, { mint: "M", rawBalance: 999_999n, readAt: 0, walletVerified: true }, 1).allowed).toBe(false));
  it("denies unverified wallet", () =>
    expect(tokenGate(p, { mint: "M", rawBalance: 5_000_000n, readAt: 0, walletVerified: false }, 1).allowed).toBe(false));
  it("denies stale read", () =>
    expect(tokenGate(p, { mint: "M", rawBalance: 5_000_000n, readAt: 0, walletVerified: true }, 60_001).allowed).toBe(false));
});

describe("metadata + AI factuality", () => {
  it("rejects expiring/foreign image URLs", () => {
    const errs = validateMetadata(
      { name: "Loco", symbol: "LOCO", description: "", imageUrl: "https://evil.io/a.png", metadataUri: "https://s.co/m.json?token=abc" },
      "https://s.co",
    );
    expect(errs.length).toBe(2);
  });
  it("flags invented numbers in AI brief", () => {
    expect(briefFactualityIssues("Depth at 1.5 SOL probe moved 0.42%", ["probe 1.5 SOL", "impact 0.42%"])).toEqual([]);
    expect(briefFactualityIssues("TVL is 9,000,000", ["probe 1.5 SOL"])).toEqual(["Unsupported number: 9,000,000"]);
    expect(briefFactualityIssues("Guaranteed APY", [])).toHaveLength(1);
  });
});

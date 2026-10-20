import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { proofMessage, sanitizePassport, MetadataInput, ScoutInput, type ProofChallenge, type ScoutFacts } from "@/lib/depot-contracts";
import { buildMetadataBody, decodeImage, gateDecision, proofDomain, scoutBrief, scoutFacts, sha256Hex, verifyWalletSignature, metadataUri } from "@/lib/depot.server";
import { serveImage, serveMetadata } from "@/lib/depot-public.server";

const sk = ed25519.utils.randomPrivateKey();
const wallet = bs58.encode(ed25519.getPublicKey(sk));
const ch: ProofChallenge = {
  domain: "studioloco.cfd", purpose: "controller", agentId: "6f1c1d1e-0000-4000-8000-000000000001", wallet,
  nonce: "ab".repeat(32), issuedAt: "2026-10-20T18:00:00.000Z", expiresAt: "2026-10-20T18:05:00.000Z",
};
const sign = (m: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(m), sk));

describe("wallet proof", () => {
  it("accepts a real signature over the exact message", () => {
    expect(verifyWalletSignature(proofMessage(ch), sign(proofMessage(ch)), wallet)).toBe(true);
  });
  it("rejects a signature for a different agent/purpose/domain", () => {
    const sig = sign(proofMessage(ch));
    expect(verifyWalletSignature(proofMessage({ ...ch, agentId: ch.agentId.replace("1", "2") }), sig, wallet)).toBe(false);
    expect(verifyWalletSignature(proofMessage({ ...ch, purpose: "viewer" }), sig, wallet)).toBe(false);
    expect(verifyWalletSignature(proofMessage({ ...ch, domain: "evil.io" }), sig, wallet)).toBe(false);
  });
  it("rejects a different wallet and malformed keys", () => {
    const other = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
    expect(verifyWalletSignature(proofMessage(ch), sign(proofMessage(ch)), other)).toBe(false);
    expect(verifyWalletSignature(proofMessage(ch), sign(proofMessage(ch)), "1111")).toBe(false);
  });
  it("only allowlisted domains", () => {
    expect(proofDomain("studioloco.cfd")).toBe("studioloco.cfd");
    expect(proofDomain("studioloco.cfd.evil.io")).toBeNull();
    expect(proofDomain(null)).toBeNull();
  });
});

describe("public passport sanitization", () => {
  it("drops every non-whitelisted field", () => {
    const p = sanitizePassport({ id: "x", name: "n", user_id: "secret", launch: { k: 1 }, rpc: "https://k", metadata: [{ digest: "d", version: 1, publishedAt: "t", body: "x" }] }) as unknown as Record<string, unknown>;
    expect(p["user_id"]).toBeUndefined();
    expect(p["launch"]).toBeUndefined();
    expect(p["rpc"]).toBeUndefined();
    expect((p["metadata"] as Record<string, unknown>[])[0]!["body"]).toBeUndefined();
  });
});

describe("metadata", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const b64 = btoa(String.fromCharCode(...png));
  it("requires explicit immutability confirmation", () => {
    expect(() => MetadataInput.parse({ agentId: ch.agentId, name: "Loco", symbol: "LOCO", description: "", imageBase64: b64, imageMime: "image/png", confirmImmutable: false })).toThrow();
  });
  it("rejects mismatched image bytes", () => {
    expect(() => decodeImage(b64, "image/jpeg")).toThrow(/match/);
    expect(decodeImage(b64, "image/png").length).toBe(7);
  });
  it("digest is deterministic and URI fits 200 bytes", () => {
    const a = buildMetadataBody({ name: "Loco", symbol: "LOCO", description: "d", image: "https://studioloco.cfd/i" });
    expect(buildMetadataBody({ name: "Loco", symbol: "LOCO", description: "d", image: "https://studioloco.cfd/i" }).digest).toBe(a.digest);
    expect(metadataUri("id-preview--24853ceb-2343-4b7d-9ed0-298ff931d003.lovable.app", a.digest).length).toBeLessThanOrEqual(200);
  });
  it("public route serves only matching digest content", async () => {
    const { body, digest } = buildMetadataBody({ name: "L", symbol: "L", description: "", image: "https://s/i" });
    const ok = await serveMetadata(digest, async () => ({ data: body, error: null }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(body);
    expect((await serveMetadata(digest, async () => ({ data: body + " ", error: null }))).status).toBe(500);
    expect((await serveMetadata("../etc", async () => ({ data: body, error: null }))).status).toBe(404);
    expect((await serveMetadata(digest, async () => ({ data: null, error: null }))).status).toBe(404);
    const img = await serveImage(sha256Hex(png), async () => ({ data: [{ mime: "image/png", b64 }], error: null }));
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect((await serveImage(sha256Hex(png), async () => ({ data: [{ mime: "text/html", b64 }], error: null }))).status).toBe(404);
  });
});

describe("token gate (server decision)", () => {
  const agent = { gate_mint: "So11111111111111111111111111111111111111112", gate_min_raw: "1000000", gate_max_age_s: 60 };
  it("exact raw threshold", () => {
    expect(gateDecision(agent, { rawBalance: 1_000_000n, readAt: 0 }, true, 1).allowed).toBe(true);
    expect(gateDecision(agent, { rawBalance: 999_999n, readAt: 0 }, true, 1).allowed).toBe(false);
  });
  it("needs proven wallet, fresh read, configured gate", () => {
    expect(gateDecision(agent, { rawBalance: 9n ** 9n, readAt: 0 }, false, 1).allowed).toBe(false);
    expect(gateDecision(agent, { rawBalance: 9n ** 9n, readAt: 0 }, true, 60_001).allowed).toBe(false);
    expect(gateDecision({ ...agent, gate_mint: null }, { rawBalance: 9n ** 9n, readAt: 0 }, true, 1).allowed).toBe(false);
  });
});

const snap = {
  scope: { pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", owner: wallet, mintX: "So11111111111111111111111111111111111111112", mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimalsX: 9, decimalsY: 6, binStep: 4, position: null, journeyId: null },
  adapter: "x", startedAt: 1, observedAt: 2, slot: 300000000, chainTime: 3, rpcKind: "server", activeId: -1200, enabled: true, activated: true,
  referencePriceQ64: "1", binArrays: [], arraysPerDirection: 2, funds: null, fundsError: null, position: null,
  quotes: [
    { status: "quoted", direction: "x-to-y", inputRaw: "1000000000", consumedRaw: "1000000000", outputRaw: "150000000", lpFeeRaw: "30000", protocolFeeRaw: "100", feeOnInput: true, binArrays: [] },
    { status: "unavailable", direction: "y-to-x", inputRaw: "5000000", reason: "bin array missing" },
  ],
} as never;

describe("scout facts + AI boundary", () => {
  const f: ScoutFacts = scoutFacts(snap, 400);
  it("keeps raw strings and records gaps", () => {
    expect(f.quotes[0]!.outputRaw).toBe("150000000");
    expect(f.gaps.some((g) => g.includes("unavailable"))).toBe(true);
    expect(f.gaps.some((g) => /TVL/.test(g))).toBe(true);
  });
  const sse = (brief: string) =>
    (async () => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify({ brief }) })}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch;
  it("accepts a brief using only observed numbers", async () => {
    const r = await scoutBrief(f, "k", sse("Probe 1000000000 raw returned 150000000 raw at slot 300000000."));
    expect(r.status).toBe("ok");
  });
  it("withholds invented metrics", async () => {
    const r = await scoutBrief(f, "k", sse("TVL is 42,000,000 with 12% APY."));
    expect(r.status).toBe("rejected");
    expect(r.brief).toBeNull();
  });
  it("reports AI failure honestly, keeping deterministic facts", async () => {
    expect((await scoutBrief(f, undefined)).status).toBe("failed");
    expect((await scoutBrief(f, "k", (async () => new Response("", { status: 402 })) as unknown as typeof fetch)).reason).toMatch(/credits/);
  });
  it("probe input bounds", () => {
    expect(() => ScoutInput.parse({ agentId: ch.agentId, pool: snap["scope" as never], probesX: ["0"], probesY: ["1"] })).toThrow();
  });
});

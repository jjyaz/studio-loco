// @vitest-environment node
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/p256";
import { DEFAULT_RULE, armRule, editRule, type Rule } from "@/lib/agents";
import { ARB_COOLDOWN_MS, MAX_OBSERVATION_GAP_MS, arbTick, failedTick, handoffFor, positionTick, watchHealth, type StoredPositionRule } from "@/lib/signal-box";
import { encryptPayload, safeEndpoint, vapidJwt, vapidKeys } from "@/lib/webpush.server";
import { deltasFromMeta, parseImport, redact, statusFromSteps, stepsFromRunner, exportBundle, type FlightRecord } from "@/lib/recorder";

const X = "So11111111111111111111111111111111111111112", Y = "EPjFWv1QYeuQ7k7XvGZJ6pV8u8m7X4k8Wd6y3eYJk2Y5";
const armed = (patch: Partial<Rule> = {}) => armRule(editRule(DEFAULT_RULE, { edgeBuffer: 3, rebalanceOnExit: true, cooldownMin: 10, ...patch }), 100, 4, 1);
const stored = (rule: Rule): StoredPositionRule => ({ rule, mintX: X, mintY: Y, binStep: 4 });
const base = { watchId: "w1", revision: 1, position: "P".repeat(43), pool: "Q".repeat(43), owner: "R".repeat(43) };
const obs = (activeId: number) => ({ activeId, lower: 90, upper: 110, binStep: 4, mintX: X, mintY: Y, vol: null });

describe("Signal Box position ticks", () => {
  it("edge trigger raises one alert, then cooldown suppresses duplicates", () => {
    const a = positionTick({ ...base, stored: stored(armed()), obs: obs(109), prevOut: null, lastProposed: {}, now: 1_000_000 });
    expect(a.alert?.trigger).toBe("edge");
    const b = positionTick({ ...base, stored: stored(armed()), obs: obs(109), prevOut: null, lastProposed: a.lastProposed, now: 1_000_000 + 5 * 60_000 });
    expect(b.alert).toBeNull();
    const c = positionTick({ ...base, stored: stored(armed()), obs: obs(109), prevOut: null, lastProposed: a.lastProposed, now: 1_000_000 + 11 * 60_000 });
    expect(c.alert?.dedupe_key).not.toBe(a.alert?.dedupe_key);
  });
  it("risk-first: out-time outranks left-range once observed long enough with continuous ticks", () => {
    const r = armed({ outMinutes: 10, outWithdrawPct: 50 });
    let t = 10_000_000, out = null as ReturnType<typeof positionTick>["outRun"], lp = {};
    const triggers: (string | undefined)[] = [];
    let hit;
    for (let i = 0; i < 4; i++) { const k = positionTick({ ...base, stored: stored(r), obs: obs(120), prevOut: out, lastProposed: lp, now: t }); out = k.outRun; lp = k.lastProposed; t += 5 * 60_000; triggers.push(k.alert?.trigger); if (k.alert?.trigger === "out-time") hit = k; }
    // 0, 5 min: left-range (first alert, then its cooldown); 10 min: out-time wins; 15 min: out-time cooldown
    expect(triggers).toEqual(["left-range", undefined, "out-time", undefined]);
    expect(hit!.alert?.payload["withdrawPct"]).toBe(50);
  });
  it("an observation gap restarts out-duration", () => {
    const r = armed({ outMinutes: 10 });
    const first = positionTick({ ...base, stored: stored(r), obs: obs(120), prevOut: null, lastProposed: {}, now: 1e7 });
    const later = positionTick({ ...base, stored: stored(r), obs: obs(120), prevOut: first.outRun, lastProposed: {}, now: 1e7 + MAX_OBSERVATION_GAP_MS + 1 });
    expect(later.outRun?.startedAt).toBe(1e7 + MAX_OBSERVATION_GAP_MS + 1);
  });
  it("failed reads are unavailable, reset out-duration and never alert", () => {
    const f = failedTick("RPC 429", { k: 1 });
    expect(f).toMatchObject({ ok: false, outRun: null, alert: null, summary: { state: "unavailable" }, lastProposed: { k: 1 } });
  });
  it("mint identity change fails the tick", () => {
    const t = positionTick({ ...base, stored: stored(armed()), obs: { ...obs(100), mintY: X }, prevOut: null, lastProposed: {}, now: 1 });
    expect(t.ok).toBe(false);
  });
  it("unavailable volatility never triggers", () => {
    const r = armed({ volatility: { frame: "5m", candles: 12, thresholdPct: 0.1, withdrawPct: 25 }, edgeBuffer: null });
    const t = positionTick({ ...base, stored: stored(r), obs: { ...obs(100), vol: { state: "unavailable", reason: "stale" } }, prevOut: null, lastProposed: {}, now: 1 });
    expect(t.alert).toBeNull();
    expect(t.summary["vol"]).toMatchObject({ state: "unavailable" });
  });
});

describe("Signal Box arb ticks", () => {
  const route = (v: "profitable" | "unprofitable", p: string | null) => ({ poolA: "A", poolB: "B", nameA: "a", nameB: "b", verdict: v, expectedProfitLamports: p });
  it("no profitable route → no alert; partial evidence is labelled", () => {
    const t = arbTick({ watchId: "w", revision: 1, routes: [route("unprofitable", "-2024791")], complete: false, poolCount: 4, inputSol: "0.1", lastProposed: {}, now: 1 });
    expect(t.alert).toBeNull();
    expect(String(t.summary["evidence"])).toMatch(/insufficient evidence/);
  });
  it("profitable route alerts once per cooldown", () => {
    const a = arbTick({ watchId: "w", revision: 1, routes: [route("profitable", "5000")], complete: true, poolCount: 4, inputSol: "0.1", lastProposed: {}, now: 1e9 });
    expect(a.alert?.trigger).toBe("arb-floor-met");
    expect(a.alert?.reason).toMatch(/fresh wallet-specific requote/);
    expect(arbTick({ watchId: "w", revision: 1, routes: [route("profitable", "5000")], complete: true, poolCount: 4, inputSol: "0.1", lastProposed: a.lastProposed, now: 1e9 + ARB_COOLDOWN_MS - 1 }).alert).toBeNull();
  });
});

describe("Signal Box health + handoff", () => {
  const w = { status: "active", expires_at: new Date(1e13).toISOString(), last_ok_at: new Date(0).toISOString(), last_run_at: new Date(0).toISOString(), consecutive_errors: 0, created_at: new Date(0).toISOString() };
  it("stale data is never healthy", () => { expect(watchHealth(w, 60 * 60_000)).toBe("stale"); });
  it("expiry wins", () => { expect(watchHealth({ ...w, expires_at: new Date(5).toISOString() }, 10)).toBe("expired"); });
  it("handoff carries identifiers only", () => {
    const h = handoffFor({ id: "a1", watch_kind: "position", payload: { owner: "O", position: "P", tx: "SHOULD-NOT-PASS" } });
    expect(h).toEqual({ to: "/app/agents", search: { alert: "a1", inspect: "O", focus: "P" } });
    expect(handoffFor({ id: "a2", watch_kind: "arb", payload: {} })).toEqual({ to: "/app/dispatch", search: { alert: "a2" } });
  });
});

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm as never, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as never, info: info as never }, k, len * 8));
}

describe("Web Push (RFC 8291 / VAPID)", () => {
  it("payload decrypts with the subscriber's private key", async () => {
    const uaPriv = p256.utils.randomPrivateKey(), uaPub = p256.getPublicKey(uaPriv, false), auth = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPayload(new TextEncoder().encode('{"alert":"x"}'), uaPub, auth);
    const salt = body.slice(0, 16), asPub = body.slice(21, 86), ct = body.slice(86);
    const enc = new TextEncoder();
    const shared = p256.getSharedSecret(uaPriv, asPub, true).slice(1);
    const ikm = await hkdf(auth, shared, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek as never, "AES-GCM", false, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as never }, key, ct as never));
    expect(pt[pt.length - 1]).toBe(2);
    expect(new TextDecoder().decode(pt.slice(0, -1))).toBe('{"alert":"x"}');
  });
  it("VAPID JWT verifies against the derived public key, deterministic per seed", () => {
    const k = vapidKeys("s".repeat(64));
    expect(vapidKeys("s".repeat(64)).pub).toEqual(k.pub);
    const jwt = vapidJwt("https://fcm.googleapis.com/fcm/send/abc", k.priv);
    const [h, c, s] = jwt.split(".");
    const sig = Uint8Array.from(atob(s!.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s!.length % 4)) % 4)), (x) => x.charCodeAt(0));
    const { sha256 } = require("@noble/hashes/sha256");
    expect(p256.verify(sig, sha256(new TextEncoder().encode(`${h}.${c}`)), k.pub)).toBe(true);
  });
  it("rejects non-https and private push endpoints", () => {
    expect(safeEndpoint("http://push.example.com/x")).toBe(false);
    expect(safeEndpoint("https://127.0.0.1/x")).toBe(false);
    expect(safeEndpoint("https://localhost/x")).toBe(false);
    expect(safeEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
  });
});

describe("Flight Recorder", () => {
  it("redacts URLs, keys and long byte blobs", () => {
    const r = redact(`failed at https://mainnet.helius-rpc.com/?api-key=SECRET123 token=abc ${"A".repeat(200)}`);
    expect(r).not.toMatch(/helius|SECRET123|abc|AAAAAAAAAA/);
  });
  it("status: unknown dominates; partial when a later step fails after a confirmation", () => {
    expect(statusFromSteps([{ phase: "confirmed" }, { phase: "unknown" }])).toBe("unknown");
    expect(statusFromSteps([{ phase: "confirmed" }, { phase: "failed" }])).toBe("partial");
    expect(statusFromSteps([{ phase: "rejected" }])).toBe("rejected");
    expect(statusFromSteps([{ phase: "sending" }])).toBe("open");
  });
  it("runner steps drop logs/pending data", () => {
    const s = stepsFromRunner([{ label: "Withdraw", phase: "unknown", signature: "5".repeat(88), logs: ["Program log: x"], pending: { signature: "x", blockhash: "b", lastValidBlockHeight: 1, cluster: "mainnet-beta", rpc: "relay", wallet: "w", label: "l", createdAt: 1 } }], 5);
    expect(Object.keys(s[0]!).sort()).toEqual(["at", "label", "phase", "signature"]);
  });
  it("import validates strictly and marks provenance", () => {
    const good: FlightRecord = { v: 1, id: "tx-abcdefgh", kind: "wallet-action", provenance: "this-device", createdAt: 1, updatedAt: 2, route: "/app", cluster: "devnet", rpc: "relay", wallet: "", title: "t", status: "confirmed", links: {}, context: {}, steps: [], timeline: [], postState: [] };
    const out = parseImport(exportBundle([good, { ...good, id: "bad id!", signedTx: "AAAA" } as unknown as FlightRecord]));
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.provenance).toBe("import");
    expect(out.rejected).toBe(1);
  });
  it("balance deltas come only from the wallet's own accounts", () => {
    const d = deltasFromMeta({ wallet: "W", accountKeys: ["W", "Z"], preBalances: [1_000_000, 5], postBalances: [994_000, 5], fee: 5000,
      preToken: [{ owner: "W", mint: Y, amount: "100", decimals: 6 }, { owner: "Z", mint: Y, amount: "1", decimals: 6 }], postToken: [{ owner: "W", mint: Y, amount: "250", decimals: 6 }] });
    expect(d).toEqual({ solDeltaLamports: "-6000", tokenDeltas: [{ mint: Y, delta: "150", decimals: 6 }] });
    expect(deltasFromMeta({ wallet: "Q", accountKeys: ["W"], preBalances: [1], postBalances: [2], fee: 1, preToken: [], postToken: [] }).solDeltaLamports).toBeNull();
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { encryptPayload, safeEndpoint, unb64u, b64u, validSubscriptionKeys } from "@/lib/webpush.server";
import { runTick, type WatchRow } from "@/lib/signal-worker.server";
import type { TickOutcome } from "@/lib/signal-box";

describe("RFC 8291 Appendix A test vector", () => {
  it("produces the exact published aes128gcm body", async () => {
    const plaintext = unb64u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
    const body = await encryptPayload(
      plaintext,
      unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
      { asPriv: unb64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    expect(b64u(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("push endpoint allowlist", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QHxyz",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts provider %s", (u) => expect(safeEndpoint(u)).toBe(true));
  it.each([
    "https://push.example.com/x",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.1/x",
    "https://fcm.googleapis.com\\@evil.example/x",
    "https://notify.windows.com.evil.example/x",
  ])("rejects %s", (u) => expect(safeEndpoint(u)).toBe(false));
});

describe("subscription key validation", () => {
  const p256dh = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  it("accepts a real P-256 point and 16-byte auth", () => expect(validSubscriptionKeys(p256dh, "BTBZMqHH6r4Tts7J_aSIgg")).toBe(true));
  it("rejects off-curve points, wrong lengths and bad encodings", () => {
    const bad = unb64u(p256dh); bad[64] ^= 1;
    expect(validSubscriptionKeys(b64u(bad), "BTBZMqHH6r4Tts7J_aSIgg")).toBe(false);
    expect(validSubscriptionKeys(p256dh, "BTBZMqHH6r4Tts7J_aSI")).toBe(false);
    expect(validSubscriptionKeys(p256dh.replace("B", "+"), "BTBZMqHH6r4Tts7J_aSIgg")).toBe(false);
  });
});

describe("service worker navigation", () => {
  const self: Record<string, unknown> = { addEventListener: () => undefined };
  new Function("self", readFileSync("public/signal-sw.js", "utf8"))(self);
  const path = self["signalHandoffPath"] as (a: unknown) => string;
  it("only builds same-origin inbox links from a valid alert UUID", () => {
    expect(path("3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b")).toBe("/app/signal-box?alert=3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b");
    for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example/app/signal-box", "javascript:alert(1)", "3f2b8c1e-9a4d-4e2b-8f1a-0c9d8e7f6a5b/../../x", null, 7]) {
      expect(path(evil)).toBe("/app/signal-box");
    }
  });
  it("ignores payload-supplied url fields", () => {
    expect(readFileSync("public/signal-sw.js", "utf8")).not.toMatch(/d\.url|data\.url/);
  });
});

/* ---- worker lease / deadline behaviour against a fake admin client ---- */
function fakeAdmin(o: { tickInsertFails?: boolean; commitReason?: string; watches: Partial<WatchRow>[] }) {
  const calls: { rpc: string; args: Record<string, unknown> }[] = [];
  const updates: string[] = [];
  const chain = (table: string): unknown => {
    let op = "select";
    const q: Record<string, unknown> = {
      insert: () => { op = "insert"; return q; }, update: () => { op = "update"; updates.push(table); return q; },
      select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q,
      single: () => Promise.resolve(o.tickInsertFails ? { data: null, error: { message: "boom" } } : { data: { id: 42 }, error: null }),
      then: (res: (v: unknown) => void) => res(table === "signal_watches" && op === "select" ? { data: o.watches, error: null } : { data: null, error: null }),
    };
    return q;
  };
  const admin = {
    from: chain,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args });
      if (name === "signal_acquire_lease") return { data: true, error: null };
      if (name === "signal_commit") return { data: o.commitReason ? { committed: false, reason: o.commitReason } : { committed: true, alert_id: null }, error: null };
      return { data: null, error: null };
    },
  };
  return { admin: admin as never, calls, updates };
}
const ok: TickOutcome = { ok: true, summary: { state: "in-range" }, error: null, outRun: null, lastProposed: {}, alert: null };
const w = (id: string) => ({ id, user_id: "u", kind: "position", revision: 3, last_proposed: {}, last_run_at: null });

describe("worker lease and deadline", () => {
  it("commits with its own lease holder and releases the same holder", async () => {
    const f = fakeAdmin({ watches: [w("a")] });
    await runTick(f.admin, { connection: {} as never, observe: async () => ok });
    const acquire = f.calls.find((c) => c.rpc === "signal_acquire_lease")!.args["_holder"];
    expect(f.calls.find((c) => c.rpc === "signal_commit")!.args["_holder"]).toBe(acquire);
    expect(f.calls.at(-1)).toEqual({ rpc: "signal_release_lease", args: { _holder: acquire } });
  });
  it("stops after a lease-lost refusal instead of committing more", async () => {
    const f = fakeAdmin({ watches: [w("a"), w("b")], commitReason: "lease lost" });
    const r = await runTick(f.admin, { connection: {} as never, observe: async () => ok });
    expect(f.calls.filter((c) => c.rpc === "signal_commit")).toHaveLength(1);
    expect(r.discarded).toBe(1);
  });
  it("drops a result that finishes after the deadline (no late commit)", async () => {
    let t = 0;
    const f = fakeAdmin({ watches: [w("a")] });
    const r = await runTick(f.admin, { connection: {} as never, now: () => t, budgetMs: 60_000, observe: async () => { t = 61_000; return ok; } });
    expect(r.late).toBe(1);
    expect(f.calls.some((c) => c.rpc === "signal_commit")).toBe(false);
  });
  it("times out a hung observation inside the remaining budget and records it unavailable", async () => {
    vi.useFakeTimers();
    const f = fakeAdmin({ watches: [w("a")] });
    const p = runTick(f.admin, { connection: {} as never, budgetMs: 20_000, observe: () => new Promise<never>(() => {}) });
    await vi.advanceTimersByTimeAsync(15_001);
    const r = await p;
    vi.useRealTimers();
    expect(r.errors).toBe(1);
    const c = f.calls.find((x) => x.rpc === "signal_commit")!;
    expect(c.args["_ok"]).toBe(false);
    expect(c.args["_summary"]).toEqual({ state: "unavailable" });
  });
  it("still releases the lease when the tick row insert fails", async () => {
    const f = fakeAdmin({ watches: [], tickInsertFails: true });
    await runTick(f.admin, {});
    expect(f.calls.at(-1)?.rpc).toBe("signal_release_lease");
    expect(f.updates).not.toContain("signal_ticks");
  });
});

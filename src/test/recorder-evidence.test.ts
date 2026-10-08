import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBDatabase } from "fake-indexeddb";
import {
  deltasFromMeta,
  exportBundle,
  parseImport,
  sanitizeRecord,
  type FlightRecord,
} from "@/lib/recorder";
import type { PendingTx, TxStep } from "@/lib/tx";
const cloud = vi.hoisted(() => ({
  getUser: vi.fn(),
  read: vi.fn(),
  upsert: vi.fn(),
  scope: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: cloud.getUser },
    from: () => ({
      select: () => ({
        eq: (...args: unknown[]) => {
          cloud.scope(...args);
          return { order: () => ({ abortSignal: () => ({ range: cloud.read }) }) };
        },
      }),
      upsert: (...args: unknown[]) => {
        cloud.upsert(...args);
        return { select: () => ({ abortSignal: async () => ({ data: [], error: null }) }) };
      },
    }),
  },
}));

const wallet = "So11111111111111111111111111111111111111112";
const signature = "5".repeat(88);
const record = (patch: Partial<FlightRecord> = {}): FlightRecord => ({
  v: 1,
  id: "tx-original-evidence",
  kind: "wallet-action",
  provenance: "this-device",
  createdAt: 100,
  updatedAt: 200,
  route: "/app/agents",
  cluster: "mainnet-beta",
  rpc: "relay",
  wallet,
  title: "Withdraw",
  status: "unknown",
  links: {},
  context: {},
  steps: [{ label: "Withdraw", phase: "unknown", signature, at: 200 }],
  timeline: [],
  postState: [],
  ...patch,
});
const pending = (): PendingTx => ({
  signature,
  wallet,
  cluster: "mainnet-beta",
  rpc: "relay",
  label: "Withdraw",
  blockhash: wallet,
  lastValidBlockHeight: 10,
  createdAt: 100,
});

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  cloud.getUser
    .mockReset()
    .mockResolvedValue({ data: { user: { id: "22222222-2222-4222-8222-222222222222" } } });
  cloud.read.mockReset().mockResolvedValue({ data: [], error: null });
  cloud.upsert.mockReset();
  cloud.scope.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Recorder persistence and evidence boundaries", () => {
  it("survives a reload and reconciles the signature without touching an imported copy", async () => {
    let store = await import("@/lib/recorder-store");
    await store.putRecord(record());
    const imported = parseImport(exportBundle([record({ status: "confirmed" })])).records[0]!;
    expect(imported.id).not.toBe(record().id);
    await store.putRecord(imported);
    vi.resetModules();
    store = await import("@/lib/recorder-store");
    expect((await store.listRecords()).length).toBe(2);
    await store.reconcileSignature(signature, "failed", "Landed with an on-chain error", pending());
    expect((await store.getRecord(record().id))?.status).toBe("failed");
    expect((await store.getRecord(imported.id))?.status).toBe("confirmed");
  });
  it("keeps a quota-failed write visible even while IndexedDB reads still work", async () => {
    const store = await import("@/lib/recorder-store");
    await store.putRecord(record());
    const original = IDBDatabase.prototype.transaction;
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (args[1] === "readwrite") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return original.apply(this, args);
    });
    await store.putRecord(record({ updatedAt: 300, status: "failed" }));
    expect(store.usingMemoryFallback()).toBe(true);
    expect((await store.listRecords())[0]?.status).toBe("failed");
    transaction.mockRestore();
    await store.putRecord(record({ updatedAt: 400, status: "confirmed" }));
    expect((await store.listRecords())[0]?.updatedAt).toBe(400);
  });
  it("records a thirteenth step failure and a late signature on an unchanged phase", async () => {
    const store = await import("@/lib/recorder-store");
    const action = store.startWalletRecord({
      route: "/app/agents",
      cluster: "mainnet-beta",
      rpc: "relay",
      wallet,
      labels: ["Withdraw"],
    });
    const steps: TxStep[] = Array.from({ length: 13 }, (_, i) => ({
      label: `Step ${i + 1}`,
      phase: i === 12 ? "unknown" : "confirmed",
    }));
    action.update(steps);
    action.update(steps.map((s, i) => (i === 12 ? { ...s, signature } : s)));
    await action.flush();
    const r = await store.getRecord(action.id);
    expect(r?.steps).toHaveLength(13);
    expect(r?.status).toBe("unknown");
    expect(r?.steps[12]?.signature).toBe(signature);
    expect(r?.timeline.at(-1)?.detail).toContain(signature);
  });
  it("does not call an unavailable receipt verified", async () => {
    const store = await import("@/lib/recorder-store");
    const action = store.startWalletRecord({
      route: "/app",
      cluster: "mainnet-beta",
      rpc: "relay",
      wallet,
      labels: ["Withdraw"],
    });
    await action.addPostState({
      verifiedAt: 300,
      source: "getTransaction",
      signature,
      slot: null,
      feeLamports: null,
      err: null,
      solDeltaLamports: null,
      tokenDeltas: [],
      note: "RPC timed out",
    });
    expect((await store.getRecord(action.id))?.timeline.at(-1)?.event).toBe("metadata unavailable");
  });
  it("serializes concurrent review facts so cancellation cannot lose preparation evidence", async () => {
    const store = await import("@/lib/recorder-store");
    const base = {
      id: "rev-evidence-test",
      kind: "review" as const,
      title: "Review",
      cluster: "mainnet-beta",
      route: "/app/agents",
    };
    await Promise.all([
      store.recordFact({ ...base, status: "open", detail: "Preparing" }),
      store.recordFact({ ...base, status: "rejected", detail: "Cancelled" }),
    ]);
    const r = await store.getRecord(base.id);
    expect(r?.timeline.map((t) => t.detail)).toEqual(["Preparing", "Cancelled"]);
    expect(r?.status).toBe("rejected");
  });
  it("does not reconcile another network or wallet's evidence", async () => {
    const store = await import("@/lib/recorder-store");
    await store.putRecord(record({ cluster: "devnet" }));
    await store.reconcileSignature(signature, "confirmed", "Confirmed on mainnet", pending());
    const rs = await store.listRecords();
    expect(rs.find((r) => r.cluster === "devnet")?.status).toBe("unknown");
    expect(rs.find((r) => r.cluster === "mainnet-beta")?.status).toBe("confirmed");
  });
  it("pulls a newer private copy before upload, and never uploads imports", async () => {
    const store = await import("@/lib/recorder-store");
    const local = record({ updatedAt: 200 }),
      newer = record({ updatedAt: 300, status: "confirmed" });
    await store.putRecord(local);
    cloud.read.mockResolvedValueOnce({ data: [{ id: newer.id, record: newer }], error: null });
    const imported = parseImport(exportBundle([local])).records[0]!;
    const result = await store.syncToCloud([local, imported]);
    expect(result).toEqual({ pushed: 0, pulled: 1 });
    expect(cloud.upsert).not.toHaveBeenCalled();
    expect(cloud.scope).toHaveBeenCalledWith("user_id", "22222222-2222-4222-8222-222222222222");
    expect((await store.getRecord(local.id))?.status).toBe("confirmed");
  });
  it("redacts secret keys and bearer/JWT values at export and import boundaries", () => {
    const r = record({
      context: {
        apiKey: "short-secret",
        authorization: "short-bearer",
        rpcUrl: "https://private-rpc.example/key",
        explanation: "Authorization: Bearer xyz-secret",
      },
      timeline: [{ at: 200, event: "error", detail: "access_token=abc-secret" }],
    });
    const clean = JSON.stringify(exportBundle([r]));
    expect(clean).not.toMatch(/short-secret|short-bearer|private-rpc|xyz-secret|abc-secret/);
    const imported = JSON.stringify(
      parseImport({ format: "studio-loco-flight-recorder/v1", records: [r] }),
    );
    expect(imported).not.toMatch(/short-secret|short-bearer|private-rpc|xyz-secret|abc-secret/);
    expect(sanitizeRecord(r).context["apiKey"]).toBe("[redacted]");
  });
  it("rejects invalid export envelopes and reports overflow", () => {
    expect(() => parseImport({ records: [] })).toThrow();
    expect(
      parseImport({
        format: "studio-loco-flight-recorder/v1",
        records: Array.from({ length: 2001 }, () => record()),
      }).rejected,
    ).toBe(1);
  });
  it("omits unsafe lamport integers and inconsistent/malformed token amounts", () => {
    const r = deltasFromMeta({
      wallet,
      accountKeys: [wallet],
      preBalances: [Number.MAX_SAFE_INTEGER + 1],
      postBalances: [100],
      fee: 1,
      preToken: [{ owner: wallet, mint: wallet, amount: "100", decimals: 9 }],
      postToken: [{ owner: wallet, mint: wallet, amount: "200", decimals: 6 }],
    });
    expect(r).toEqual({ solDeltaLamports: null, tokenDeltas: [] });
    expect(
      deltasFromMeta({
        wallet,
        accountKeys: [],
        preBalances: [],
        postBalances: [],
        fee: 1,
        preToken: [{ owner: wallet, mint: wallet, amount: "NaN", decimals: 9 }],
        postToken: [],
      }).tokenDeltas,
    ).toEqual([]);
  });
});

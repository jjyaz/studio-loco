import { describe, expect, it, vi } from "vitest";
import BN from "bn.js";
import { parseUnits, formatUnits, bpsOf } from "@/lib/amount";
import { distribute, importRoutes, exportRoutes, encodeShare, decodeShare, type SavedRoute } from "@/lib/strategy";
import { binFromUiPrice, uiPriceFromBin, baseFeePct } from "@/lib/bins";
import { runTransaction, runSequence, TxError } from "@/lib/tx";
import { fetchJson, ApiError } from "@/lib/meteora-api";
import { practicePage } from "@/lib/practice-data";
import { rangeState } from "@/components/app/positions";
import { tallyBallot, tallySealedBid, tallyHistogram, newKey, seal, open } from "@/lib/lab";

describe("amount parsing", () => {
  it("parses exactly without floats", () => {
    const r = parseUnits("1.5", 6);
    expect(r.ok && r.raw.toString()).toBe("1500000");
    const big = parseUnits("123456789.123456789", 9);
    expect(big.ok && big.raw.toString()).toBe("123456789123456789");
    const tricky = parseUnits("0.1", 18);
    expect(tricky.ok && tricky.raw.toString()).toBe("100000000000000000");
    expect(parseUnits(".25", 2).ok).toBe(true);
  });
  it("rejects bad input", () => {
    expect(parseUnits("1.1234567", 6).ok).toBe(false);
    expect(parseUnits("-1", 6).ok).toBe(false);
    expect(parseUnits("1e5", 6).ok).toBe(false);
    expect(parseUnits("", 6).ok).toBe(false);
    expect(parseUnits("1.2.3", 6).ok).toBe(false);
  });
  it("formats", () => {
    expect(formatUnits(new BN("1500000"), 6)).toBe("1.5");
    expect(formatUnits("1", 9)).toBe("0.000000001");
    expect(formatUnits("123456789000", 3)).toBe("123,456,789");
    expect(formatUnits("1234567", 6, 2)).toBe("1.23");
    expect(bpsOf(new BN(10000), 50).toString()).toBe("50");
  });
});

describe("strategy normalization", () => {
  for (const s of ["Spot", "Curve", "BidAsk"] as const) {
    it(`${s} sums to 1 per side and respects sides`, () => {
      const d = distribute(s, 0, -10, 10);
      expect(d).toHaveLength(21);
      expect(d.reduce((a, b) => a + b.x, 0)).toBeCloseTo(1, 10);
      expect(d.reduce((a, b) => a + b.y, 0)).toBeCloseTo(1, 10);
      expect(d.filter((b) => b.binId < 0).every((b) => b.x === 0)).toBe(true);
      expect(d.filter((b) => b.binId > 0).every((b) => b.y === 0)).toBe(true);
    });
  }
  it("shapes differ correctly", () => {
    const c = distribute("Curve", 0, -10, 10);
    const ba = distribute("BidAsk", 0, -10, 10);
    expect(c.find((b) => b.binId === 1)!.x).toBeGreaterThan(c.find((b) => b.binId === 10)!.x);
    expect(ba.find((b) => b.binId === 10)!.x).toBeGreaterThan(ba.find((b) => b.binId === 1)!.x);
  });
  it("one-sided ranges", () => {
    const d = distribute("Spot", 0, 5, 9);
    expect(d.reduce((a, b) => a + b.y, 0)).toBe(0);
    expect(d.reduce((a, b) => a + b.x, 0)).toBeCloseTo(1);
    expect(distribute("Spot", 0, 5, 1)).toEqual([]);
  });
  it("route file round trip and validation", () => {
    const r: SavedRoute = { id: "a", name: "Test", pool: "DQ9weJhfiU4iL5LUoeshDrm5KxDHCMiSbnnKJz7buMcf", strategy: "Curve", below: 5, above: 5, budget: 10, xShare: 0.5, createdAt: 1 };
    const ok = importRoutes(exportRoutes([r]));
    expect(ok.ok && ok.routes[0]!.name).toBe("Test");
    expect(importRoutes("{").ok).toBe(false);
    expect(importRoutes(JSON.stringify({ kind: "studio-loco/routes", version: 2, routes: [] })).ok).toBe(false);
    expect(importRoutes(exportRoutes([{ ...r, below: 40, above: 40 }])).ok).toBe(false);
    expect(decodeShare(encodeShare(r))).toEqual(r);
    expect(decodeShare("garbage")).toBeNull();
  });
});

describe("bin math", () => {
  it("round-trips price and bin", () => {
    const p = uiPriceFromBin(-1200, 25, 9, 6);
    expect(binFromUiPrice(p, 25, 9, 6)).toBe(-1200);
    expect(binFromUiPrice(0, 25, 9, 6)).toBeNaN();
  });
  it("base fee from preset", () => {
    expect(baseFeePct(10000, 100, 0)).toBeCloseTo(1);
    expect(baseFeePct(10000, 25, 0)).toBeCloseTo(0.25);
  });
  it("range state", () => {
    expect(rangeState(10, 0, 20, 3)).toBe("in-range");
    expect(rangeState(1, 0, 20, 3)).toBe("approaching-edge");
    expect(rangeState(21, 0, 20, 3)).toBe("out-of-range");
  });
});

/* -------- transaction runner -------- */
function mockConn(opts: { simErr?: unknown; confErr?: unknown } = {}) {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "BH", lastValidBlockHeight: 100 }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: opts.simErr ?? null, logs: ["log1"] } }),
    confirmTransaction: vi.fn().mockResolvedValue({ context: { slot: 5 }, value: { err: opts.confErr ?? null } }),
  };
}
const wallet = (send: () => Promise<string>) => ({ publicKey: { toBase58: () => "W" }, sendTransaction: vi.fn(send) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tx = () => ({}) as any;

describe("transaction runner", () => {
  it("succeeds only after confirmation with blockhash + lastValidBlockHeight", async () => {
    const c = mockConn();
    const w = wallet(async () => "SIG");
    const phases: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runTransaction({ connection: c as any, wallet: w as any, tx: tx(), onPhase: (p) => phases.push(p) });
    expect(r.signature).toBe("SIG");
    expect(c.confirmTransaction).toHaveBeenCalledWith({ signature: "SIG", blockhash: "BH", lastValidBlockHeight: 100 }, "confirmed");
    expect(phases).toEqual(["preparing", "simulating", "awaiting-signature", "confirming", "confirmed"]);
  });
  it("never asks the wallet when simulation fails", async () => {
    const c = mockConn({ simErr: { InstructionError: [0, "Custom"] } });
    const w = wallet(async () => "SIG");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runTransaction({ connection: c as any, wallet: w as any, tx: tx() })).rejects.toMatchObject({ phase: "simulating" });
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });
  it("reports onchain failure even with a signature", async () => {
    const c = mockConn({ confErr: { InstructionError: [1, "X"] } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = await runTransaction({ connection: c as any, wallet: wallet(async () => "S2") as any, tx: tx() }).catch((x) => x);
    expect(e).toBeInstanceOf(TxError);
    expect(e.signature).toBe("S2");
  });
  it("detects wallet rejection and partial sequences", async () => {
    const c = mockConn();
    let n = 0;
    const w = wallet(async () => { n++; if (n === 2) throw new Error("User rejected the request."); return `S${n}`; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = await runSequence({ connection: c as any, wallet: w as any, steps: [{ label: "a", tx: tx() }, { label: "b", tx: tx() }, { label: "c", tx: tx() }], onUpdate: () => {} });
    expect(steps.map((s) => s.phase)).toEqual(["confirmed", "rejected", "skipped"]);
  });
});

describe("api client", () => {
  it("retries 429 then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await fetchJson("u", { fetchImpl: f as unknown as typeof fetch })).toEqual({ ok: 1 });
  });
  it("throws typed http errors, no fallback", async () => {
    const f = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(fetchJson("u", { fetchImpl: f as unknown as typeof fetch, retries: 0 })).rejects.toBeInstanceOf(ApiError);
  });
  it("practice data is clearly fictional", () => {
    const p = practicePage({ page: 1, pageSize: 5, sort: "tvl", dir: "desc" });
    expect(p.data.every((x) => x.address.startsWith("PRACTICE-"))).toBe(true);
    expect(p.data[0]!.tvl).toBeGreaterThanOrEqual(p.data[1]!.tvl!);
  });
});

describe("lab", () => {
  it("tallies", () => {
    expect(tallyBallot(["a", "b", "a", "z"], ["a", "b"])).toEqual({ counts: { a: 2, b: 1 }, invalid: 1 });
    expect(tallySealedBid(["5", "9", "7"])).toEqual({ winner: 1, clearing: 7, count: 3 });
    expect(tallyHistogram(["1", "15", "200"], [10, 100])).toEqual([1, 1, 1]);
  });
  it("seals and verifies commitments", async () => {
    const k = await newKey();
    const s = await seal(k, "p", "42");
    expect(await open(k, s)).toEqual({ value: "42", verified: true });
    expect((await open(k, { ...s, commitment: "00" })).verified).toBe(false);
  });
});

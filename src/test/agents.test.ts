// @vitest-environment node
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  DEFAULT_RULE, REVIEW_TTL_MS, allocation, armRule, balancedTarget, binsForPctMove, editRule, evaluate, observeOut, observedMs, pairOrientation,
  parseCommand, parseRuleStore, pctMoveBetweenBins, propose, rebaseAfterConfirmedRebalance, reviewStaleReason, rpcIdentity, rulesStorageKey,
  spendRefusal, volatility, type FrozenReview, type LiveIdentity, type Rule,
} from "@/lib/agents";
import { verifyRebalanceTarget } from "@/lib/agents-chain";
import { memoryPendingStore, runSequence } from "@/lib/tx";

const OWNER = "So11111111111111111111111111111111111111112";
const POS = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const armed = (patch: Partial<Rule> = {}, active = 1000) => armRule({ ...DEFAULT_RULE, ...patch }, active, 25, 1);
const pos = (activeId: number, lower = 990, upper = 1010) => ({ key: POS, pool: "P", activeId, lower, upper, binStep: 25 });

describe("rule assistant grammar", () => {
  it("parses supported commands into explicit parameters", () => {
    const r = parseCommand("Review my range after a 5% price move; alert me within 3 bins of the edge\nprepare a 50% withdrawal after 15 minutes out of range");
    expect(r.ok && r.patch).toEqual({ priceMovePct: 5, edgeBuffer: 3, outWithdrawPct: 50, outMinutes: 15 });
    const v = parseCommand("prepare a 25% withdrawal if 5m volatility over 12 candles exceeds 1.5%");
    expect(v.ok && v.patch.volatility).toEqual({ frame: "5m", candles: 12, thresholdPct: 1.5, withdrawPct: 25 });
  });
  it("rejects unknown, ambiguous and out-of-bounds commands instead of guessing", () => {
    expect(parseCommand("make me money").ok).toBe(false);
    expect(parseCommand("alert me within 3 bins of the edge; alert me within 4 bins of the edge").ok).toBe(false);
    expect(parseCommand("alert me within 99 bins of the edge").ok).toBe(false);
    expect(parseCommand("prepare a 150% withdrawal after 5 minutes out of range").ok).toBe(false);
    expect(parseCommand("").ok).toBe(false);
  });
});

describe("rules, scope and baseline", () => {
  it("edits bump revision and disarm; invalid edits throw", () => {
    const a = armed();
    const e = editRule(a, { edgeBuffer: 5 });
    expect(e.revision).toBe(a.revision + 1);
    expect(e.armed).toBe(false);
    expect(e.baseline).toBeNull();
    expect(() => editRule(a, { edgeBuffer: 3.5 })).toThrow();
    expect(() => editRule(a, { outWithdrawPct: 0 })).toThrow();
  });
  it("storage keys are scoped and never contain a URL; malformed stored rules are dropped", () => {
    const id = rpcIdentity("https://mainnet.helius-rpc.com/?api-key=SECRET");
    expect(id).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(rpcIdentity("")).toBe("relay");
    const k = rulesStorageKey(OWNER, "mainnet-beta", id);
    expect(k).not.toContain("SECRET");
    expect(k).not.toBe(rulesStorageKey(OWNER, "devnet", id));
    expect(() => rulesStorageKey(OWNER, "mainnet-beta", "https://x")).toThrow();
    const store = parseRuleStore({ v: 1, rules: { [POS]: armed(), [OWNER]: { ...DEFAULT_RULE, edgeBuffer: 999 } } });
    expect(Object.keys(store)).toEqual([POS]);
    expect(parseRuleStore({ v: 2, rules: {} })).toEqual({});
  });
  it("baseline is anchored at arm time and does not move on polls", () => {
    const r = armed({ priceMovePct: 5 });
    expect(evaluate({ rule: r, pos: pos(1001), outRun: undefined, vol: null, now: 2 }).triggers).toEqual([]);
    expect(r.baseline!.activeId).toBe(1000);
    const moved = binsForPctMove(5, 25);
    expect(evaluate({ rule: r, pos: pos(1000 + moved), outRun: undefined, vol: null, now: 3 }).triggers.map((t) => t.kind)).toContain("price-move");
    const rebased = rebaseAfterConfirmedRebalance(r, 1000 + moved, 25, 4);
    expect(rebased.baseline!.activeId).toBe(1000 + moved);
  });
  it("unarmed rules never trigger", () => {
    expect(evaluate({ rule: { ...DEFAULT_RULE }, pos: pos(2000), outRun: undefined, vol: null, now: 1 }).triggers).toEqual([]);
  });
});

describe("price/bin math", () => {
  it("is consistent in both directions", () => {
    const n = binsForPctMove(5, 25);
    expect(pctMoveBetweenBins(0, n, 25)).toBeGreaterThanOrEqual(5);
    expect(pctMoveBetweenBins(0, n - 1, 25)).toBeLessThan(5);
    expect(pctMoveBetweenBins(10, 10, 25)).toBe(0);
    expect(pctMoveBetweenBins(n, 0, 25)).toBeLessThan(0);
  });
  it("balanced target mirrors the SDK: odd widths preserved, even widths grow by one", () => {
    expect(balancedTarget(100, 21)).toEqual({ lower: 90, upper: 110 });
    const even = balancedTarget(100, 20);
    expect(even).toEqual({ lower: 89, upper: 109 });
    expect(verifyRebalanceTarget({ activeId: 100, width: 20, expected: even, deposits: [{ minDeltaId: new BN(-11), maxDeltaId: new BN(9) }], depositedX: new BN(0), depositedY: new BN(0), availX: new BN(0), availY: new BN(0) })).toMatch(/width/);
  });
});

describe("observed-time continuity", () => {
  it("counts only contiguous observations and resets after gaps or returning in range", () => {
    let r = observeOut(undefined, true, 0, 60_000);
    r = observeOut(r, true, 50_000, 60_000);
    r = observeOut(r, true, 100_000, 60_000);
    expect(observedMs(r)).toBe(100_000);
    r = observeOut(r, true, 1_000_000, 60_000); // tab closed / unobserved
    expect(observedMs(r)).toBe(0);
    expect(observeOut(r, false, 1_010_000, 60_000)).toBeUndefined();
  });
});

describe("trigger precedence, dedup and cooldown", () => {
  const rule = armed({ outMinutes: 1, outWithdrawPct: 40, rebalanceOnExit: true, priceMovePct: 1, cooldownMin: 10 });
  const outRun = { startedAt: 0, lastSeen: 120_000 };
  it("risk exit outranks rebalance and carries the chosen withdrawal", () => {
    const p = propose({ rule, pos: pos(1020), outRun, vol: null, now: 120_000 }, {});
    expect(p?.trigger).toBe("out-time");
    expect(p?.kind).toBe("reduce");
    expect(p?.withdrawPct).toBe(40);
  });
  it("dedupes within cooldown and falls through to the next trigger", () => {
    const seen: Record<string, number> = {};
    const a = propose({ rule, pos: pos(1020), outRun, vol: null, now: 120_000 }, seen)!; seen[a.id] = 120_000;
    const b = propose({ rule, pos: pos(1020), outRun, vol: null, now: 130_000 }, seen)!; seen[b.id] = 130_000;
    expect(b.trigger).toBe("left-range");
    expect(b.target).toEqual(balancedTarget(1020, 21));
    const c = propose({ rule, pos: pos(1020), outRun, vol: null, now: 140_000 }, seen)!; seen[c.id] = 140_000;
    expect(c.trigger).toBe("price-move");
    expect(propose({ rule, pos: pos(1020), outRun, vol: null, now: 150_000 }, seen)).toBeNull();
    expect(propose({ rule, pos: pos(1020), outRun, vol: null, now: 120_000 + 10 * 60_000 }, seen)?.trigger).toBe("out-time");
  });
});

describe("volatility", () => {
  const now = 10_000_000_000;
  const mk = (n: number, step = 300, last = now / 1000) => Array.from({ length: n }, (_, i) => ({ t: last - (n - 1 - i) * step, c: 100 * (i % 2 ? 1.02 : 1) }));
  it("missing or stale data is unavailable, never low", () => {
    expect(volatility(mk(5), 12, "5m", now).state).toBe("unavailable");
    expect(volatility(mk(20, 300, now / 1000 - 3600), 12, "5m", now).state).toBe("unavailable");
    const rule = armed({ volatility: { frame: "5m", candles: 12, thresholdPct: 0.1, withdrawPct: 25 } });
    const ev = evaluate({ rule, pos: pos(1000), outRun: undefined, vol: { state: "unavailable", reason: "x" }, now });
    expect(ev.volUnknown).toBe("x");
    expect(ev.triggers).toEqual([]);
  });
  it("computes and triggers on fresh data", () => {
    const v = volatility(mk(20), 12, "5m", now);
    expect(v.state).toBe("ok");
    if (v.state === "ok") expect(v.pct).toBeGreaterThan(0.5);
    const rule = armed({ volatility: { frame: "5m", candles: 12, thresholdPct: 0.5, withdrawPct: 25 } });
    const p = propose({ rule, pos: pos(1000), outRun: undefined, vol: v, now }, {});
    expect(p?.trigger).toBe("volatility");
    expect(p?.withdrawPct).toBe(25);
  });
});

describe("capital allocation", () => {
  it("separates active bin from other bins exactly; malformed is unavailable not zero", () => {
    const a = allocation([{ binId: 1, positionXAmount: "5", positionYAmount: "0" }, { binId: 2, positionXAmount: "7", positionYAmount: "3" }, { binId: 3, positionXAmount: "0", positionYAmount: "0" }], 2)!;
    expect(a.activeX).toBe(7n); expect(a.activeY).toBe(3n); expect(a.outsideX).toBe(5n); expect(a.binsWithLiquidity).toBe(2);
    expect(allocation([{ binId: 1, positionXAmount: "abc", positionYAmount: "0" }], 1)).toBeNull();
    expect(allocation(undefined, 1)).toBeNull();
    expect(allocation([{ binId: 1, positionXAmount: "0", positionYAmount: "0" }], 9)!.totalX).toBe(0n);
  });
  it("matches exact pairs including reversed orientation only", () => {
    expect(pairOrientation("A", "B", "A", "B")).toBe("same");
    expect(pairOrientation("B", "A", "A", "B")).toBe("reversed");
    expect(pairOrientation("A", "C", "A", "B")).toBeNull();
  });
});

describe("spend gating and review freshness", () => {
  it("practice and watch-only can never transact", () => {
    expect(spendRefusal({ mode: "practice", practiceSetting: false, canSign: true })).toMatch(/Practice/);
    expect(spendRefusal({ mode: "watch", practiceSetting: false, canSign: true })).toMatch(/never transact/);
    expect(spendRefusal({ mode: "wallet", practiceSetting: true, canSign: true })).toMatch(/disables/);
    expect(spendRefusal({ mode: "wallet", practiceSetting: false, canSign: true })).toBeNull();
  });
  const f: FrozenReview = { ruleRevision: 3, wallet: OWNER, cluster: "mainnet-beta", rpcId: "relay", pool: "P", position: POS, action: "rebalance", slippageBps: 50, feeLamports: 5000, solOutLamports: 0, builtAt: 1000, gen: 7 };
  const l: LiveIdentity = { ruleRevision: 3, wallet: OWNER, cluster: "mainnet-beta", rpcId: "relay", practiceSetting: false, mode: "wallet", slippageBps: 50, gen: 7, positionPresent: true };
  it("goes stale on any identity/config change, expiry or unknown cost", () => {
    expect(reviewStaleReason(f, l, 1000 + REVIEW_TTL_MS)).toBeNull();
    expect(reviewStaleReason(f, l, 1001 + REVIEW_TTL_MS)).toMatch(/expired/);
    expect(reviewStaleReason(f, { ...l, ruleRevision: 4 }, 1000)).toMatch(/edited/);
    expect(reviewStaleReason(f, { ...l, wallet: POS }, 1000)).toMatch(/wallet/);
    expect(reviewStaleReason(f, { ...l, rpcId: "custom-00000000" }, 1000)).toMatch(/RPC/);
    expect(reviewStaleReason(f, { ...l, practiceSetting: true }, 1000)).toMatch(/Practice/);
    expect(reviewStaleReason(f, { ...l, gen: 8 }, 1000)).toMatch(/changed/);
    expect(reviewStaleReason(f, { ...l, slippageBps: 100 }, 1000)).toMatch(/Slippage/);
    expect(reviewStaleReason(f, { ...l, positionPresent: false }, 1000)).toMatch(/no longer/);
    expect(reviewStaleReason({ ...f, feeLamports: null }, l, 1000)).toMatch(/unknown/);
    expect(reviewStaleReason({ ...f, solOutLamports: null }, l, 1000)).toMatch(/unknown/);
  });
  it("the runner refuses to sign when the semantic guard trips during wallet approval", async () => {
    // Expiry hits while the wallet dialog is open: the guard re-check after signing must stop the send.
    let clock = 1000;
    const signed: number[] = [];
    const { Keypair, Transaction, SystemProgram } = await import("@solana/web3.js");
    const kp = Keypair.generate();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
    const connection = {
      getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }),
      getFeeForMessage: async () => ({ value: 5000 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
      sendRawTransaction: async () => { throw new Error("must not send"); },
    } as never;
    const steps = await runSequence({
      connection, steps: [{ label: "rebalance", tx }],
      wallet: { publicKey: kp.publicKey, signTransaction: async (t) => { signed.push(1); clock += REVIEW_TTL_MS + 1; t.partialSign(kp); return t; } },
      onUpdate: () => {},
      ctx: { cluster: "mainnet-beta", rpc: "relay", store: memoryPendingStore(), maxFeeLamports: 5000, semanticGuard: () => reviewStaleReason(f, l, clock) },
    });
    expect(signed.length).toBe(1);
    expect(steps[0]!.phase).not.toBe("confirmed");
    expect(steps[0]!.error).toMatch(/expired/);
  });
  it("unknown fee blocks signing via the runner fee cap", async () => {
    const { Keypair, Transaction, SystemProgram } = await import("@solana/web3.js");
    const kp = Keypair.generate();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
    let signed = 0;
    const connection = {
      getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }),
      getFeeForMessage: async () => ({ value: null }),
      simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
    } as never;
    const steps = await runSequence({ connection, steps: [{ label: "w", tx }], wallet: { publicKey: kp.publicKey, signTransaction: async (t) => { signed++; return t; } }, onUpdate: () => {}, ctx: { cluster: "mainnet-beta", rpc: "relay", store: memoryPendingStore(), maxFeeLamports: 5000 } });
    expect(signed).toBe(0);
    expect(steps[0]!.phase).toBe("failed");
  });
  it("failed simulation never reaches the wallet", async () => {
    const { Keypair, Transaction, SystemProgram } = await import("@solana/web3.js");
    const kp = Keypair.generate();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
    let signed = 0;
    const connection = {
      getGenesisHash: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }),
      getFeeForMessage: async () => ({ value: 5000 }),
      simulateTransaction: async () => ({ value: { err: { InstructionError: [0, "Custom"] }, logs: ["boom"] } }),
    } as never;
    const steps = await runSequence({ connection, steps: [{ label: "w", tx }, { label: "w2", tx }], wallet: { publicKey: kp.publicKey, signTransaction: async (t) => { signed++; return t; } }, onUpdate: () => {}, ctx: { cluster: "mainnet-beta", rpc: "relay", store: memoryPendingStore() } });
    expect(signed).toBe(0);
    expect(steps.map((s) => s.phase)).toEqual(["failed", "skipped"]);
  });
});

describe("native rebalance target verification", () => {
  const base = { activeId: 100, width: 21, expected: balancedTarget(100, 21), depositedX: new BN(10), depositedY: new BN(10), availX: new BN(10), availY: new BN(10) };
  it("accepts exactly the reviewed same-width target with zero top-up", () => {
    expect(verifyRebalanceTarget({ ...base, deposits: [{ minDeltaId: new BN(-10), maxDeltaId: new BN(10) }] })).toBeNull();
  });
  it("rejects a different target, width change, multiple ranges or a hidden top-up", () => {
    expect(verifyRebalanceTarget({ ...base, deposits: [{ minDeltaId: new BN(-9), maxDeltaId: new BN(10) }] })).toMatch(/differs/);
    expect(verifyRebalanceTarget({ ...base, deposits: [] })).toMatch(/one deposit/);
    expect(verifyRebalanceTarget({ ...base, deposits: [{ minDeltaId: new BN(-10), maxDeltaId: new BN(10) }], depositedX: new BN(11) })).toMatch(/top-up/);
  });
});

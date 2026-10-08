// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_RULE, armRule } from "@/lib/agents";
import { DEFAULT_CONFIG } from "@/lib/arb-math";
import { MAX_OBSERVATION_GAP_MS } from "@/lib/signal-box";
import {
  bridgeHostedOut,
  handoffRule,
  validateSignalHandoff,
  type PositionHandoff,
} from "@/lib/signal-handoff";

const user = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333";
const aid = "44444444-4444-4444-8444-444444444444",
  wid = "55555555-5555-4555-8555-555555555555";
const owner = "So11111111111111111111111111111111111111112",
  position = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  pool = "11111111111111111111111111111111";
const now = 10_000_000;
const rule = armRule({ ...DEFAULT_RULE, outMinutes: 10 }, 100, 25, now - 800_000);
const alert = {
  id: aid,
  user_id: user,
  watch_id: wid,
  watch_kind: "position",
  revision: 2,
  trigger: "out-time",
  reason: "Observed out of range",
  payload: { signedTx: "malicious executable bytes", withdrawPct: 100 },
  created_at: new Date(now - 1_000).toISOString(),
};
const watch = {
  id: wid,
  user_id: user,
  kind: "position",
  cluster: "mainnet-beta",
  status: "active",
  revision: 2,
  expires_at: new Date(now + 86_400_000).toISOString(),
  rule: { rule, mintX: owner, mintY: pool, binStep: 25 },
  owner,
  position,
  pool,
  out_run: { startedAt: now - 700_000, lastSeen: now - 10_000 },
  last_ok_at: new Date(now - 10_000).toISOString(),
};
const fresh = {
  key: position,
  pair: pool,
  mintX: owner,
  mintY: pool,
  binStep: 25,
  activeId: 120,
  lower: 90,
  upper: 110,
};
const h = () => validateSignalHandoff(alert, watch, user, "position", now) as PositionHandoff;

describe("Private alert → fresh review handoff", () => {
  it("carries validated current rules, never payload execution fields", () => {
    expect(h().stored.rule).toEqual(rule);
    expect(JSON.stringify(h())).not.toContain("malicious executable bytes");
    expect(handoffRule(h(), { ...rule, revision: 25 })).toMatchObject({
      revision: 26,
      baseline: rule.baseline,
      outWithdrawPct: 50,
    });
  });
  it("rejects another user's alert, mismatched watch and wrong feature", () => {
    expect(() => validateSignalHandoff(alert, watch, other, "position", now)).toThrow(/workspace/);
    expect(() =>
      validateSignalHandoff({ ...alert, watch_id: aid }, watch, user, "position", now),
    ).toThrow(/workspace/);
    expect(() => validateSignalHandoff(alert, watch, user, "arb", now)).toThrow(/workspace/);
  });
  it("rejects edited, paused and expired watches", () => {
    expect(() =>
      validateSignalHandoff(alert, { ...watch, revision: 3 }, user, "position", now),
    ).toThrow(/edited/);
    expect(() =>
      validateSignalHandoff(alert, { ...watch, status: "paused" }, user, "position", now),
    ).toThrow(/paused/);
    expect(() =>
      validateSignalHandoff(
        alert,
        { ...watch, expires_at: new Date(now).toISOString() },
        user,
        "position",
        now,
      ),
    ).toThrow(/expired/);
  });
  it("bridges observed duration only with a fresh matching out-of-range position", () => {
    expect(bridgeHostedOut(h(), fresh, now)).toEqual({ startedAt: now - 700_000, lastSeen: now });
    expect(bridgeHostedOut(h(), { ...fresh, activeId: 100 }, now)).toBeUndefined();
    expect(() => bridgeHostedOut(h(), { ...fresh, binStep: 50 }, now)).toThrow(/identity/);
    expect(() => bridgeHostedOut(h(), { ...fresh, pair: owner }, now)).toThrow(/identity/);
    expect(bridgeHostedOut(h(), fresh, now + MAX_OBSERVATION_GAP_MS)).toBeUndefined();
  });
  it("never accepts a future, disconnected or failed observation interval", () => {
    expect(
      (
        validateSignalHandoff(
          alert,
          { ...watch, out_run: { startedAt: now - 1_000, lastSeen: now + 1_000 } },
          user,
          "position",
          now,
        ) as PositionHandoff
      ).outRun,
    ).toBeNull();
    expect(
      (
        validateSignalHandoff(
          alert,
          { ...watch, last_ok_at: null },
          user,
          "position",
          now,
        ) as PositionHandoff
      ).outRun,
    ).toBeNull();
    expect(
      (
        validateSignalHandoff(
          alert,
          { ...watch, out_run: { startedAt: now, lastSeen: now - 1_000 } },
          user,
          "position",
          now,
        ) as PositionHandoff
      ).outRun,
    ).toBeNull();
  });
  it("validates hosted arbitrage config and ignores the earlier floor/pool payload", () => {
    const a = { ...alert, watch_kind: "arb", payload: { floor: "0", poolA: "unverified" } };
    const w = {
      ...watch,
      kind: "arb",
      rule: DEFAULT_CONFIG,
      owner: null,
      position: null,
      pool: null,
    };
    expect(validateSignalHandoff(a, w, user, "arb", now)).toMatchObject({
      kind: "arb",
      config: DEFAULT_CONFIG,
    });
    expect(() =>
      validateSignalHandoff(
        a,
        { ...w, rule: { ...DEFAULT_CONFIG, inputSol: "-1" } },
        user,
        "arb",
        now,
      ),
    ).toThrow();
  });
});

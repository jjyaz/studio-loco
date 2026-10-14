import { identity, mintX, mintY } from "./journey-fixtures";
import { MissionPolicy, MissionSnapshot, type MissionQuote } from "@/lib/conductor";
export const at = 1_700_000_000_000;
export const missionScope = {
  pool: identity.pool,
  owner: identity.owner,
  mintX,
  mintY,
  decimalsX: 9,
  decimalsY: 6,
  binStep: 10,
  position: null,
  journeyId: null,
};
export function missionPolicy(now = at): MissionPolicy {
  return MissionPolicy.parse({
    v: 1,
    adapter: "ordinary-dlmm-read-v1",
    scope: missionScope,
    probesX: ["1000000"],
    probesY: ["1000000"],
    maxImpactBps: 50,
    maxSwapFeeBps: 100,
    maxDeployXRaw: "10000000",
    maxDeployYRaw: "10000000",
    minSolReserveLamports: "10000000",
    maxNetworkFeeLamports: "100000",
    allowedActions: ["rebalance", "claim", "withdraw"],
    cooldownMs: 300000,
    maxAgeMs: 120000,
    expiresAt: now + 86400000,
    approval: "fresh-wallet-review",
  });
}
export const quote = (
  direction: "x-to-y" | "y-to-x" = "x-to-y",
): Extract<MissionQuote, { status: "quoted" }> => ({
  status: "quoted",
  direction,
  inputRaw: "1000000",
  consumedRaw: "1000000",
  outputRaw: "990000",
  lpFeeRaw: "8000",
  protocolFeeRaw: "2000",
  feeOnInput: true,
  binArrays: [identity.pool],
});
export function missionSnapshot(now = at + 1000): MissionSnapshot {
  return MissionSnapshot.parse({
    scope: missionScope,
    adapter: "ordinary-dlmm-read-v1",
    startedAt: now - 500,
    observedAt: now,
    slot: 100,
    chainTime: now - 1000,
    rpcKind: "relay",
    activeId: 0,
    enabled: true,
    activated: true,
    referencePriceQ64: "18446744073709551616",
    binArrays: [identity.pool],
    arraysPerDirection: 2,
    quotes: [quote(), quote("y-to-x")],
    funds: {
      slot: 101,
      observedAt: now,
      solLamports: "1000000000",
      ataXRaw: "10000000",
      ataYRaw: "10000000",
    },
    fundsError: null,
    position: null,
    positionError: null,
  });
}

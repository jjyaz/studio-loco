import { draftBlueprint } from "@/lib/foundry";
import { newJourney, type JourneySnapshot } from "@/lib/journey";
import type { FlightRecord } from "@/lib/recorder";
export const identity = {
  kind: "position" as const,
  account: "1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id",
  pool: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  owner: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD",
};
export const mintX = "So11111111111111111111111111111111111111112",
  mintY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const blueprint = draftBlueprint({ address: identity.pool, mintX, mintY, binStep: 10 });
export const position: Extract<JourneySnapshot, { kind: "position" }> = {
  kind: "position",
  observedAt: 10_000,
  slot: 100,
  checkedSlot: 101,
  source: "relay",
  mintX,
  mintY,
  decX: 9,
  decY: 6,
  binStep: 10,
  activeId: 0,
  lower: -10,
  upper: 10,
  holdingsX: "2000000000",
  holdingsY: "8000000",
  feeX: "200",
  feeY: "100",
  claimedX: "10000",
  claimedY: "0",
  feeOwner: identity.owner,
  accountLamports: "10000000",
  rentMinimumLamports: "8000000",
  bins: [{ binId: 0, x: "2000000000", y: "8000000", shares: "10000000000000000" }],
};
export const order: Extract<JourneySnapshot, { kind: "order" }> = {
  ...position,
  kind: "order",
  unfilledX: "1000000000",
  unfilledY: "0",
  filledX: "0",
  filledY: "0",
  proceedsX: "0",
  proceedsY: "0",
  levels: [
    {
      binId: 15,
      side: "sell",
      state: "resting",
      depositX: "1000000000",
      depositY: "0",
      unfilledX: "1000000000",
      unfilledY: "0",
      filledX: "0",
      filledY: "0",
      proceedsX: "0",
      proceedsY: "0",
    },
  ],
};
// Strict snapshots exclude all position-only fields from native order evidence.
delete (order as unknown as Record<string, unknown>)["lower"];
delete (order as unknown as Record<string, unknown>)["upper"];
delete (order as unknown as Record<string, unknown>)["feeOwner"];
delete (order as unknown as Record<string, unknown>)["claimedX"];
delete (order as unknown as Record<string, unknown>)["claimedY"];
delete (order as unknown as Record<string, unknown>)["bins"];
export const journey = () => newJourney(identity, "Test Journey", 9000);
export function receipt(digest: string): FlightRecord {
  return {
    v: 1,
    id: "tx-journey-receipt",
    kind: "wallet-action",
    provenance: "this-device",
    createdAt: 5000,
    updatedAt: 6000,
    route: "/app/foundry",
    cluster: "mainnet-beta",
    rpc: "relay",
    wallet: identity.owner,
    title: "Foundry · test",
    status: "confirmed",
    links: {},
    context: {
      recordType: "foundry-action",
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      blueprintDigest: digest,
      pool: identity.pool,
      targetAccount: identity.account,
      foundryAction: "liquidity",
    },
    steps: [{ label: "Foundry action", phase: "confirmed", signature: "4".repeat(88), at: 6000 }],
    timeline: [],
    postState: [],
  };
}

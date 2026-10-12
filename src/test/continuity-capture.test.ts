import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparedCandidates, eligibleStrategies } from "@/lib/continuity-capture";
import { migrateJourney } from "@/lib/continuity";
import { identity, journey, receipt } from "./journey-fixtures";
import type { FlightRecord } from "@/lib/recorder";
function records(): FlightRecord[] {
  const wallet = receipt("a".repeat(64));
  return [
    wallet,
    {
      ...wallet,
      id: "ct-prepared-action",
      kind: "proposal",
      status: "info",
      links: { recordId: wallet.id },
      steps: [],
      context: {
        recordType: "continuity-prepared",
        txStep: 0,
        action: "withdraw",
        accountKind: "position",
        account: identity.account,
        pool: identity.pool,
        moveId: null,
        destinationPool: null,
      },
    },
  ];
}
describe("Local continuity provenance", () => {
  it("only considers confirmed local steps with a matching prepared account fact", () => {
    expect(preparedCandidates(records())).toHaveLength(1);
    const failed = records();
    failed[0]!.steps[0]!.phase = "failed";
    expect(preparedCandidates(failed)).toEqual([]);
  });
  it.each(["import", "cloud"] as const)(
    "refuses %s provenance on either half of the association",
    (provenance) => {
      const wallet = records();
      wallet[0]!.provenance = provenance;
      expect(preparedCandidates(wallet)).toEqual([]);
      const fact = records();
      fact[1]!.provenance = provenance;
      expect(preparedCandidates(fact)).toEqual([]);
    },
  );
  it("does not accept mismatched wallets or step indexes", () => {
    const rows = records();
    rows[1]!.wallet = identity.pool;
    expect(preparedCandidates(rows)).toEqual([]);
    const bad = records();
    bad[1]!.context["txStep"] = 256;
    expect(preparedCandidates(bad)).toEqual([]);
  });
  it("does not infer destination ancestry from a proposal or query pointer alone", () => {
    const rows = records();
    rows[1]!.context["action"] = "deposit";
    rows[1]!.context["moveId"] = "plan-fake-query";
    const candidate = preparedCandidates(rows)[0]!;
    const j = journey();
    j.links = [
      {
        recordId: rows[0]!.id,
        signature: "4".repeat(88),
        slot: 100,
        blueprintId: "bp-origin",
        revision: 1,
        digest: "a".repeat(64),
        name: "Origin",
        action: "liquidity",
        feeLamports: "5000",
      },
    ];
    const s = migrateJourney(j)!;
    const unknown = { ...candidate, account: identity.pool, pool: identity.owner };
    expect(eligibleStrategies([s], unknown)).toEqual([]);
    expect(
      eligibleStrategies(
        [
          {
            ...s,
            provenance: "import",
            accounts: s.accounts.map((a) => ({ ...a, verification: "user-supplied" })),
          },
        ],
        candidate,
      ),
    ).toEqual([]);
  });
});

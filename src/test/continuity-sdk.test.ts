import { describe, expect, it } from "vitest";
import { analyzeContinuityExport } from "../../packages/sdk/src/continuity";
import { StrategySchema as SdkStrategySchema } from "../../packages/sdk/src/continuity-schema";
import { exportContinuity, manualStrategy, StrategySchema } from "@/lib/continuity";
import { identity } from "./journey-fixtures";
describe("Read-only continuity SDK", () => {
  it("validates the shared contract and reports supplied evidence without authentication claims", () => {
    const s = manualStrategy("Portable history", identity),
      bundle = exportContinuity([s]);
    expect(SdkStrategySchema.parse(s)).toEqual(StrategySchema.parse(s));
    expect(analyzeContinuityExport(bundle)).toMatchObject({
      source: "local-export",
      chainVerified: false,
      executable: false,
      strategiesRecorded: 1,
      accountsReferenced: 1,
    });
  });
  it("refuses duplicate IDs and credential fields", () => {
    const s = manualStrategy("A", identity);
    expect(() => analyzeContinuityExport(exportContinuity([s, s]))).toThrow("Duplicate strategy");
    expect(() =>
      analyzeContinuityExport({ ...exportContinuity([s]), rpcUrl: "https://private.invalid" }),
    ).toThrow();
  });
  it("requires complete ancestry relations using the same app/SDK schema", () => {
    const s = manualStrategy("A", identity),
      invalid = { ...s, accounts: [{ ...s.accounts[0]!, fromAccount: identity.pool }] };
    expect(StrategySchema.safeParse(invalid).success).toBe(false);
    expect(SdkStrategySchema.safeParse(invalid).success).toBe(false);
  });
});

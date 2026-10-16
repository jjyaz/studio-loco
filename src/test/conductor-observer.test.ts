import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { sealMissionPolicy } from "@/lib/conductor";
import { validateHostedConfig, hostedSampleReport } from "@/lib/conductor-hosted";
import { observeHostedMission, missionObservationFailure } from "@/lib/conductor-observer.server";
import { JobTimeout } from "@/lib/job-control";
import { missionPolicy, missionSnapshot, at } from "./conductor-fixtures";
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(at + 2000);
});
async function config() {
  return {
    v: 1 as const,
    kind: "loco-hosted-mission" as const,
    missionId: "mission-observer-001",
    policy: await sealMissionPolicy(missionPolicy(), 1, at),
  };
}
const connection = {} as Connection;
describe("hosted Conductor read-only observation", () => {
  it("validates digest/expiry before invoking a reader", async () => {
    const c = await config(),
      read = vi.fn();
    await expect(
      observeHostedMission(
        connection,
        { ...c, policy: { ...c.policy, digest: "a".repeat(64) } },
        null,
        1000,
        read,
      ),
    ).rejects.toThrow(/digest/);
    expect(read).not.toHaveBeenCalled();
    await expect(validateHostedConfig(c, c.policy.policy.expiresAt)).rejects.toThrow(/expired/);
  });
  it("keeps server snapshot evidence and increments the retained-attempt counter", async () => {
    const c = await config(),
      snap = { ...missionSnapshot(), rpcKind: "server" as const };
    const out = await observeHostedMission(
      connection,
      c,
      { v: 1, kind: "mission-observation-counter", count: 61 },
      1000,
      async () => snap,
    );
    expect(out.ok).toBe(true);
    expect(out.outRun?.count).toBe(62);
    expect(out.alert).toBeNull();
    expect(out.summary["snapshot"]).toEqual(snap);
    expect(hostedSampleReport(out.summary, at + 200000).state).toBe("unknown");
    expect(hostedSampleReport(out.summary, at + 2000).recordedState).toBe("met");
  });
  it("records explicit gaps and rejects a wrong scope rather than substituting old data", async () => {
    const c = await config();
    const gap = missionObservationFailure(c, null, "RPC https://example.com/secret timed out");
    expect(gap.ok).toBe(false);
    expect(gap.summary["snapshot"]).toBeNull();
    expect(gap.error).not.toContain("https");
    const out = await observeHostedMission(connection, c, null, 1000, async () => ({
      ...missionSnapshot(),
      rpcKind: "server",
      scope: { ...missionPolicy().scope, binStep: 99 },
    }));
    expect(out.ok).toBe(false);
    expect(out.summary["snapshot"]).toBeNull();
  });
  it("propagates an unabortable timeout so the shared worker stops further reads", async () => {
    await expect(
      observeHostedMission(connection, await config(), null, 1000, async () => {
        throw new JobTimeout("RPC", 1000);
      }),
    ).rejects.toBeInstanceOf(JobTimeout);
  });
});

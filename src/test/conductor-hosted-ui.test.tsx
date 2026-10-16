import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConductorHosted } from "@/components/app/ConductorHosted";
import { createConductorMission, sealMissionPolicy } from "@/lib/conductor";
import { missionPolicy, missionSnapshot } from "./conductor-fixtures";
const mocks = vi.hoisted(() => ({
  session: null as any,
  list: vi.fn(),
  create: vi.fn(),
  samples: vi.fn(),
  change: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/components/signal/account", () => ({
  useCloudSession: () => ({
    session: mocks.session,
    userId: mocks.session ? "private-account" : null,
    ready: true,
  }),
  AccountPanel: () => <p>Private sign-in</p>,
}));
vi.mock("@/lib/conductor-hosted.functions", () => ({
  listHostedMissions: (...a: unknown[]) => mocks.list(...a),
  createHostedMission: (...a: unknown[]) => mocks.create(...a),
  getHostedMissionSamples: (...a: unknown[]) => mocks.samples(...a),
  changeHostedMission: (...a: unknown[]) => mocks.change(...a),
}));
beforeEach(() => {
  mocks.session = null;
  mocks.list.mockReset().mockResolvedValue({ missions: [], tick: null });
  mocks.create.mockReset().mockResolvedValue({ ok: true, id: "test-copy" });
  mocks.samples.mockReset();
  mocks.change.mockReset();
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
describe("private hosted observation consent", () => {
  it("does not request account data or upload when disconnected", async () => {
    wrap(<ConductorHosted now={Date.now()} />);
    expect(screen.getByRole("button", { name: "Connect private workspace" })).toBeVisible();
    await Promise.resolve();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires explicit configuration consent before creating a hosted copy", async () => {
    mocks.session = { user: { id: "private-account" } };
    const now = Date.now(),
      m = createConductorMission(
        "Private opt-in",
        await sealMissionPolicy(missionPolicy(now), 1, now - 2000),
        missionSnapshot(now - 1000),
      );
    wrap(<ConductorHosted mission={m} now={now} />);
    const button = await screen.findByRole("button", { name: "Enable hosted observation" });
    expect(button).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      consent: true,
      config: {
        kind: "loco-hosted-mission",
        missionId: m.id,
        policy: { digest: m.policies[0]!.digest },
      },
    });
  });
});

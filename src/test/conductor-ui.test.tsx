import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Conductor, QuotePlot } from "@/components/app/Conductor";
import { createConductorMission, sealMissionPolicy, evaluateMission } from "@/lib/conductor";
import { missionPolicy, missionSnapshot } from "./conductor-fixtures";
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  live: true,
  connection: {},
  observe: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: mocks.connection }),
  useWallet: () => ({ publicKey: null }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: any) => <a href={props.to}>{children}</a>,
}));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({
    hydrated: true,
    settings: { practice: !mocks.live, cluster: "mainnet-beta", rpc: { "mainnet-beta": "" } },
  }),
}));
vi.mock("@/lib/conductor-store", () => ({
  listMissions: async () => mocks.rows,
  subscribeConductor: () => () => {},
  saveNewMission: vi.fn(),
  appendMissionPolicy: vi.fn(),
  setMissionStatus: vi.fn(),
  removeMission: vi.fn(),
}));
vi.mock("@/lib/journey-store", () => ({
  listJourneys: async () => [],
  subscribeJourney: () => () => {},
}));
vi.mock("@/lib/conductor-capture", () => ({
  observeConductorMission: (...args: unknown[]) => mocks.observe(...args),
  repairConductorRecorder: (...args: unknown[]) => mocks.repair(...args),
}));
beforeEach(() => {
  mocks.rows = [];
  mocks.live = true;
  mocks.observe.mockReset().mockResolvedValue({ recorderError: null });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});
async function mission() {
  const now = Date.now();
  return createConductorMission(
    "Public watch-only mission",
    await sealMissionPolicy(missionPolicy(now), 1, now - 2000),
    missionSnapshot(now - 1000),
  );
}
describe("Conductor workbench", () => {
  it("shows a real-scope empty state with no fabricated quotes", async () => {
    render(<Conductor />);
    expect(await screen.findByText("Start with a real market.")).toBeVisible();
    expect(screen.getByLabelText("DLMM pool address")).toBeVisible();
    expect(screen.queryByText("Mission met")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("allows watch-only observations and clearly separates policy preview from execution", async () => {
    const m = await mission();
    mocks.rows = [m];
    render(<Conductor />);
    expect(await screen.findByText("Public watch-only mission", { selector: "h2" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("Needs fresh execution evidence")).toBeVisible();
    expect(screen.queryByRole("button", { name: /sign|execute/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Observe now" }));
    await screen.findByText("Fresh observation saved and linked to Flight Recorder.");
    expect(mocks.observe).toHaveBeenCalledOnce();
  });
  it("does not show a failed latest read as currently met", async () => {
    const m = await mission();
    mocks.rows = [{ ...m, lastError: "RPC unavailable" }];
    render(<Conductor />);
    expect(await screen.findByText("Latest read failed · current health is unknown")).toBeVisible();
    expect(screen.getByText("Evidence incomplete")).toBeVisible();
    expect(screen.queryByText("Mission met")).not.toBeInTheDocument();
  });
  it("keeps saved evidence readable in Practice but disables live reads", async () => {
    mocks.rows = [await mission()];
    mocks.live = false;
    render(<Conductor />);
    expect(await screen.findByText("Live mainnet mode required")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Observe now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export evidence" })).toBeEnabled();
  });
  it("renders unavailable probe sizes explicitly rather than as zero bars", () => {
    const s = missionSnapshot();
    s.quotes[0] = {
      status: "unavailable",
      direction: "x-to-y",
      inputRaw: "1000000",
      reason: "Coverage unavailable",
    };
    const r = evaluateMission(missionPolicy(), s, s.observedAt);
    render(
      <QuotePlot
        probes={r.probes.filter((p) => p.quote.direction === "x-to-y")}
        ceiling={50}
        decimals={9}
      />,
    );
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(screen.queryByText("0 bp")).not.toBeInTheDocument();
  });
});

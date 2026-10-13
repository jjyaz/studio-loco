import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Switchyard, SwitchyardPlot } from "@/components/app/Switchyard";
import {
  createShadowExperiment,
  appendShadowObservation,
  type ShadowExperiment,
} from "@/lib/switchyard";
import { identity, position, journey } from "./journey-fixtures";
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  source: [] as unknown[],
  live: true,
  connection: {},
  list: vi.fn(),
  observe: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: mocks.connection }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({
    hydrated: true,
    settings: { practice: !mocks.live, cluster: "mainnet-beta", rpc: { "mainnet-beta": "" } },
  }),
}));
vi.mock("@/lib/switchyard-store", () => ({
  listShadowExperiments: () => mocks.list(),
  subscribeSwitchyard: () => () => {},
  saveShadowExperiment: (...a: unknown[]) => mocks.save(...a),
  setShadowStatus: vi.fn(),
  removeShadowExperiment: vi.fn(),
}));
vi.mock("@/lib/journey-store", () => ({
  listJourneys: async () => mocks.source,
  subscribeJourney: () => () => {},
  saveJourney: vi.fn(),
}));
vi.mock("@/lib/recorder-store", () => ({
  listRecords: async () => [],
  subscribeRecorder: () => () => {},
}));
vi.mock("@/lib/continuity-store", () => ({ listStrategies: async () => [] }));
vi.mock("@/lib/journey-chain", () => ({
  readJourneySnapshot: (...a: unknown[]) => mocks.read(...a),
}));
vi.mock("@/lib/switchyard-chain", () => ({
  observeShadowExperiment: (...a: unknown[]) => mocks.observe(...a),
  repairShadowRecorder: vi.fn(),
}));
function sample(): ShadowExperiment {
  const at = Date.now();
  return createShadowExperiment({
    identity,
    snapshot: { ...position, observedAt: at - 1000 },
    label: "Prospective UI",
    now: at,
    policy: {
      version: 1,
      edgeBins: 3,
      cooldownMs: 300_000,
      widenByBins: 20,
      maxWidthBins: 69,
      assumedFeeLamports: null,
    },
  });
}
beforeEach(() => {
  mocks.rows = [];
  mocks.source = [{ ...journey(), snapshots: [position] }];
  mocks.live = true;
  mocks.list.mockReset().mockImplementation(async () => mocks.rows);
  mocks.observe.mockReset().mockResolvedValue(null);
  mocks.read.mockReset();
  mocks.save.mockReset();
});
describe("Switchyard product states", () => {
  it("shows an honest empty state without fabricated performance", async () => {
    render(<Switchyard />);
    expect(await screen.findByText("The next decision deserves context.")).toBeVisible();
    expect(screen.queryByText("Observed range coverage")).not.toBeInTheDocument();
  });
  it("keeps supplied experiments readable and excludes monitoring and promotion", async () => {
    const e = sample();
    mocks.rows = [
      { ...e, id: "switch-import", suppliedId: e.id, provenance: "import", status: "paused" },
    ];
    render(<Switchyard />);
    expect(await screen.findByText("Supplied history")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resume experiment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Observe now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Compare in Planner/ })).not.toBeInTheDocument();
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  it("does not start a live experiment from Practice mode", async () => {
    mocks.live = false;
    render(<Switchyard />);
    await screen.findByText("The next decision deserves context.");
    fireEvent.click(screen.getByRole("button", { name: "New comparison" }));
    fireEvent.change(screen.getByLabelText("Tracked LP position"), {
      target: { value: journey().id },
    });
    expect(screen.getByRole("button", { name: "Start live comparison" })).toBeDisabled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("requires storage and reports failure without silently substituting a simulated study", async () => {
    mocks.list.mockRejectedValue(new Error("Persistent storage is blocked"));
    render(<Switchyard />);
    expect(await screen.findByText("Device evidence unavailable")).toBeVisible();
    expect(screen.queryByText("The next decision deserves context.")).not.toBeInTheDocument();
    expect(screen.queryByText("Observed range coverage")).not.toBeInTheDocument();
  });
  it("renders the pre-action observed range and identifies the source as a point comparison", () => {
    const e = sample(),
      at = e.createdAt + 1000;
    const next = appendShadowObservation(
      e,
      { ...position, observedAt: at, slot: 102, checkedSlot: 103, activeId: 20 },
      at,
    );
    render(<SwitchyardPlot experiment={next} track="recenter" />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/1 point observations/);
    expect(screen.getByText(/prior range -10..10/)).toBeInTheDocument();
  });
});

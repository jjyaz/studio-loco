import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyBoard } from "@/routes/app.journey";
import { appendSnapshot } from "@/lib/journey";
import { identity, journey, position } from "./journey-fixtures";
const m = vi.hoisted(() => ({
  rows: [] as unknown[],
  read: vi.fn(),
  save: vi.fn(),
  capture: vi.fn(),
  settings: { cluster: "mainnet-beta", practice: false, rpc: { "mainnet-beta": "" } },
  notify: null as (() => void) | null,
  records: [] as unknown[],
  blueprints: [] as unknown[],
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (c: unknown) => c,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: { rpcEndpoint: "relay" } }),
}));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({ settings: m.settings, hydrated: true }),
}));
vi.mock("@/lib/journey-store", () => ({
  listJourneys: async () => m.rows,
  saveJourney: m.save,
  removeJourney: vi.fn(),
  subscribeJourney: (f: () => void) => {
    m.notify = f;
    return () => {};
  },
}));
vi.mock("@/lib/recorder-store", () => ({
  listRecords: async () => m.records,
  recordFact: vi.fn(),
  subscribeRecorder: () => () => {},
}));
vi.mock("@/lib/foundry-store", () => ({
  listBlueprints: async () => m.blueprints,
  subscribeFoundry: () => () => {},
}));
vi.mock("@/lib/journey-chain", () => ({
  readJourneySnapshot: m.read,
  verifiedNetworkFees: () => "0",
}));
vi.mock("@/lib/journey-capture", () => ({
  captureFoundryReceipt: m.capture,
  journeyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/signal-box.functions", () => ({ createWatch: vi.fn() }));
vi.mock("@/components/signal/account", () => ({ useCloudSession: () => ({ userId: null }) }));
beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.records = [];
  m.blueprints = [];
  m.settings.cluster = "mainnet-beta";
  m.settings.practice = false;
  m.read.mockResolvedValue({ ...position, observedAt: Date.now() });
  m.save.mockImplementation(async (j) => {
    m.rows = [j];
    m.notify?.();
    return j;
  });
});
afterEach(cleanup);
describe("Journey interface", () => {
  it("renders a truthful empty journey without invented live metrics", async () => {
    render(<JourneyBoard />);
    await screen.findByText("Every route needs a first stop.");
    expect(screen.getByText("Verified receipt links")).toBeInTheDocument();
    expect(m.read).not.toHaveBeenCalled();
  });
  it("requires verified public identities before saving a watch-only account", async () => {
    render(<JourneyBoard initial={identity} />);
    await screen.findByLabelText("Account address");
    fireEvent.click(screen.getByRole("button", { name: "Verify & track" }));
    await waitFor(() => expect(m.save).toHaveBeenCalledTimes(1));
    expect(m.read.mock.calls[0]?.[1]).toEqual(identity);
    expect(m.save.mock.calls[0]?.[0].links).toEqual([]);
    await screen.findByText("Watch-only · no blueprint proof");
  });
  it("never saves a failed chain verification", async () => {
    m.read.mockRejectedValue(new Error("Wrong pool owner"));
    render(<JourneyBoard initial={identity} />);
    await screen.findByLabelText("Account address");
    fireEvent.click(screen.getByRole("button", { name: "Verify & track" }));
    await screen.findByText("Wrong pool owner");
    expect(m.save).not.toHaveBeenCalled();
  });
  it("invalidates an in-flight form result after the account changes", async () => {
    let resolve!: (s: unknown) => void;
    m.read.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<JourneyBoard initial={identity} />);
    await screen.findByLabelText("Account address");
    fireEvent.click(screen.getByRole("button", { name: "Verify & track" }));
    await waitFor(() => expect(m.read).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Account address"), {
      target: { value: position.mintX },
    });
    await act(async () => {
      resolve({ ...position, observedAt: Date.now() });
    });
    expect(m.save).not.toHaveBeenCalled();
  });
  it("blocks live account verification in practice mode", async () => {
    m.settings.practice = true;
    render(<JourneyBoard initial={identity} />);
    await screen.findByLabelText("Account address");
    expect(screen.getByRole("button", { name: "Verify & track" })).toBeDisabled();
    expect(m.read).not.toHaveBeenCalled();
  });
  it("labels stale snapshots and keeps hosted alerts disabled until refreshed", async () => {
    m.rows = [appendSnapshot(journey(), position)];
    render(<JourneyBoard />);
    await screen.findByText("STALE · in range");
    expect(screen.getByRole("button", { name: "Enable hosted range alerts" })).toBeDisabled();
    expect(screen.getByText("Lifetime claimed · X")).toBeInTheDocument();
    expect(screen.getByText("Linked action network fees")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});

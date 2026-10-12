import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContinuityBoard, SnapshotComparison } from "@/components/app/ContinuityBoard";
import { manualStrategy, migrateJourney, summarize, type Strategy } from "@/lib/continuity";
import { identity, journey, position } from "./journey-fixtures";
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  list: vi.fn(),
  save: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@solana/wallet-adapter-react", () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/lib/continuity-store", () => ({
  listStrategies: () => mocks.list(),
  migrateJourneys: async () => 0,
  subscribeContinuity: () => () => {},
  saveStrategy: (...args: unknown[]) => mocks.save(...args),
  removeStrategy: vi.fn(),
  restoreOrigins: async () => 0,
}));
vi.mock("@/lib/continuity-capture", () => ({
  preparedCandidates: () => [],
  eligibleStrategies: () => [],
  reconcileContinuity: (...args: unknown[]) => mocks.verify(...args),
}));
beforeEach(() => {
  mocks.rows = [];
  mocks.list.mockReset().mockImplementation(async () => mocks.rows);
  mocks.save.mockReset();
  mocks.verify.mockReset().mockResolvedValue({ verified: 1, attempted: 1, errors: [] });
});
const view = () =>
  render(
    <ContinuityBoard
      journeys={[{ ...journey(), snapshots: [position] }]}
      records={[]}
      live
      source="relay"
      onAccount={vi.fn()}
    />,
  );
describe("Continuity user states", () => {
  it("starts with the real first-run state, without fabricated chapters", async () => {
    view();
    expect(await screen.findByText("Liquidity carries its history.")).toBeVisible();
    expect(screen.queryByText("Lifecycle chapters")).not.toBeInTheDocument();
  });
  it("keeps a manual group supplied and verification disabled", async () => {
    mocks.rows = [manualStrategy("My public watch", identity)];
    view();
    expect(await screen.findByText("USER-SUPPLIED · READ-ONLY EVIDENCE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify pending chapters" })).toBeDisabled();
    expect(screen.getByText("Supplied history")).toBeVisible();
  });
  it("creates watch-only grouping without a wallet or signing request", async () => {
    const s = manualStrategy("A route", identity);
    mocks.save.mockResolvedValue(s);
    view();
    await screen.findByText("Liquidity carries its history.");
    fireEvent.click(screen.getByRole("button", { name: "Create watch-only group" }));
    fireEvent.change(screen.getByLabelText("Watch-only group name"), {
      target: { value: "A route" },
    });
    fireEvent.change(screen.getByLabelText("Tracked account for grouping"), {
      target: { value: journey().id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save watch-only group" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0]![0].provenance).toBe("user-supplied");
  });
  it("shows unavailable observations as unavailable, not zero balances", () => {
    render(<SnapshotComparison before={null} after={null} />);
    expect(screen.getAllByText(/no zero balance is substituted/)).toHaveLength(2);
  });
  it("does not label imported confirmations or closures independently verified", async () => {
    const s = manualStrategy("Imported chapter", identity);
    mocks.rows = [{ ...s, provenance: "import" } as Strategy];
    view();
    expect(await screen.findByText("Supplied history")).toBeVisible();
    expect(screen.queryByText("Independently checked")).not.toBeInTheDocument();
  });
  it("shows a durable-store failure clearly", async () => {
    mocks.list.mockRejectedValue(new Error("Persistent device storage is unavailable"));
    view();
    expect(await screen.findByText("Persistent device storage is unavailable")).toBeVisible();
  });
});

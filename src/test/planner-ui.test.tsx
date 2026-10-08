import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RebalancePlanner } from "@/components/app/RebalancePlanner";
import type { PlanSnapshot } from "@/lib/planner";

const mocks = vi.hoisted(() => ({ read: vi.fn(), fact: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { rows: [] }, isPending: false }),
}));
vi.mock("@/lib/planner-chain", () => ({ readPlan: mocks.read }));
vi.mock("@/lib/recorder-store", () => ({ recordFact: mocks.fact }));
const owner = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD";
const row = {
  key: "1Be6ZXynELowU6JjN1VRR4pRMEeAywdgpQdeKJp44id",
  pair: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  lower: 90,
  upper: 109,
  activeId: 100,
  mintX: "So11111111111111111111111111111111111111112",
  mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decX: 9,
  decY: 6,
};
const base = {
  mode: "wallet" as const,
  owner,
  cluster: "mainnet-beta",
  rpcId: "relay",
  position: row.key,
  pool: row.pair,
  strategy: "Spot" as const,
  slippageBps: 50,
  ruleRevision: -1,
  watchRevision: null,
};
const result = () => ({
  activeId: 100,
  current: { lower: 90, upper: 109 },
  slot: 1,
  mintX: row.mintX,
  mintY: row.mintY,
  decX: 9,
  decY: 6,
  results: [
    { option: "keep", target: null, sim: "none", rentLamports: 0n },
    {
      option: "recenter",
      target: { lower: 90, upper: 109 },
      sim: "sdk-ok",
      rentLamports: 0n,
      depositX: "10000",
      depositY: "20000",
      withdrawX: "10000",
      withdrawY: "20000",
      costs: {
        feeLamports: 5000,
        solOutLamports: 5000,
        requiredLamports: 5000,
        walletLamports: 1000000,
        simError: null,
        units: 1000,
        size: 500,
        remaining: 0,
      },
    },
  ],
});
beforeEach(() => {
  let seq = 0;
  mocks.read.mockReset().mockImplementation(async () => result());
  mocks.fact.mockReset().mockImplementation(async (o) => o.id ?? `prop-0000000${++seq}`);
});
afterEach(cleanup);
describe("Planner UI boundaries", () => {
  it("watch-only comparisons save evidence but never enable a wallet review", async () => {
    const review = vi.fn();
    render(
      <RebalancePlanner
        row={row}
        base={{ ...base, mode: "watch" }}
        connection={{} as never}
        actionBlock="Watch-only"
        onReview={review}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare with fresh chain state" }));
    expect(await screen.findByRole("button", { name: "Rebuild fresh review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Record “stay put”" }));
    await screen.findByText(/Saved selection/);
    expect(review).not.toHaveBeenCalled();
    expect(mocks.fact.mock.calls[0]![0].context.executable).toBe(false);
  });
  it("creates a distinct immutable comparison each time and links the chosen option", async () => {
    const review = vi.fn<(s: PlanSnapshot, o: string, id: string) => void>();
    render(
      <RebalancePlanner
        row={row}
        base={base}
        connection={{} as never}
        actionBlock={null}
        onReview={review}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare with fresh chain state" }));
    await screen.findByRole("button", { name: "Rebuild fresh review" });
    const firstId = mocks.fact.mock.calls[0]![0].id;
    fireEvent.click(screen.getByRole("button", { name: "Compare with fresh chain state" }));
    await waitFor(() =>
      expect(
        mocks.fact.mock.calls.filter(([o]) => o.context.recordType === "rebalance-comparison"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Compare with fresh chain state" })).toBeEnabled(),
    );
    const comparisons = mocks.fact.mock.calls.filter(
      ([o]) => o.context.recordType === "rebalance-comparison",
    );
    expect(comparisons[1]![0].id).not.toBe(firstId);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild fresh review" }));
    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    const selected = mocks.fact.mock.calls.at(-1)![0];
    expect(selected.links.recordId).toBe(comparisons[1]![0].id);
  });
  it("an input change during Recorder persistence discards the late comparison", async () => {
    let finish!: (id: string) => void;
    mocks.fact.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    );
    render(
      <RebalancePlanner
        row={row}
        base={base}
        connection={{} as never}
        actionBlock={null}
        onReview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare with fresh chain state" }));
    await waitFor(() => expect(mocks.fact).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Widen · lower level"), { target: { value: "84" } });
    await act(async () => {
      finish("plan-00000001");
    });
    expect(screen.queryByRole("button", { name: "Rebuild fresh review" })).toBeNull();
  });
  it("practice never calls real planning reads or opens approval", () => {
    render(
      <RebalancePlanner
        row={row}
        base={{ ...base, mode: "practice" }}
        connection={{} as never}
        actionBlock="Practice"
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByText("Practice example only")).toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

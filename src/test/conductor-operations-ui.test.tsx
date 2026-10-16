import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConductorOperations } from "@/components/app/ConductorOperations";
import { createConductorMission, sealMissionPolicy } from "@/lib/conductor";
import { missionPolicy, missionSnapshot } from "./conductor-fixtures";
const mocks = vi.hoisted(() => ({
  budgets: [] as any[],
  operations: [] as any[],
  seal: vi.fn(),
  build: vi.fn(),
  run: vi.fn(),
  wallet: null as any,
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: {} }),
  useWallet: () => ({ publicKey: mocks.wallet }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...p }: any) => <a href={p.to}>{children}</a>,
}));
vi.mock("@/components/app/useTx", () => ({
  useTxRunner: () => ({ run: mocks.run, canSign: !!mocks.wallet, steps: null, running: false }),
  TxSteps: () => null,
}));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({
    settings: { cluster: "mainnet-beta", practice: false, rpc: { "mainnet-beta": "" } },
  }),
}));
vi.mock("@/lib/conductor-store", () => ({ subscribeConductor: () => () => {} }));
vi.mock("@/lib/ledger-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ledger-store")>();
  return {
    ...original,
    listLedger: async () => ({ budgets: mocks.budgets, operations: mocks.operations }),
    sealBudget: (...a: unknown[]) => mocks.seal(...a),
  };
});
vi.mock("@/lib/conductor-execution", () => ({
  buildMissionAction: (...a: unknown[]) => mocks.build(...a),
}));
beforeEach(() => {
  mocks.budgets = [];
  mocks.operations = [];
  mocks.wallet = null;
  mocks.run.mockReset();
  mocks.seal.mockReset().mockResolvedValue(undefined);
  mocks.build.mockReset();
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});
async function mission(position = false) {
  const now = Date.now(),
    p = missionPolicy(now);
  if (position) {
    p.scope.position = p.scope.pool;
    p.scope.journeyId = "journey-ui-0001";
  }
  const snapshot = missionSnapshot(now - 1000);
  snapshot.scope = p.scope;
  return createConductorMission(
    "UI budget mission",
    await sealMissionPolicy(p, 1, now - 2000),
    snapshot,
  );
}
describe("Conductor execution controls", () => {
  it("seals exact cumulative units without a wallet prompt and keeps pool-only execution unavailable", async () => {
    const m = await mission();
    render(<ConductorOperations mission={m} now={Date.now()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create cumulative budget" }));
    fireEvent.change(screen.getByLabelText("Total USDC top-ups"), {
      target: { value: "1.234567" },
    });
    fireEvent.change(screen.getByLabelText("Total SOL operating budget"), {
      target: { value: "0.025" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Seal execution budget" }));
    await waitFor(() => expect(mocks.seal).toHaveBeenCalledOnce());
    expect(mocks.seal.mock.calls[0]![0]).toMatchObject({
      totalYRaw: "1234567",
      totalLamports: "25000000",
      policyDigest: m.policies[0]!.digest,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Reserve budget & approve in wallet" }),
    ).not.toBeInTheDocument();
  });
  it("permits unsigned inspection but prevents a watch-only user from signing", async () => {
    const m = await mission(true),
      p = m.policies[0]!;
    mocks.budgets = [
      {
        key: `${m.id}#0001`,
        missionId: m.id,
        sealedAt: Date.now(),
        budget: {
          v: 1,
          kind: "cumulative-execution-budget",
          scope: {
            missionId: m.id,
            owner: p.policy.scope.owner,
            cluster: "mainnet-beta",
            pool: p.policy.scope.pool,
            mintX: p.policy.scope.mintX,
            mintY: p.policy.scope.mintY,
          },
          revision: 1,
          policyDigest: p.digest,
          totalXRaw: "0",
          totalYRaw: "0",
          totalLamports: "25000000",
          allowedActions: p.policy.allowedActions,
          expiresAt: p.policy.expiresAt,
        },
      },
    ];
    mocks.build.mockResolvedValue({
      action: "claim",
      digest: p.digest,
      budgetRevision: 1,
      costs: { requiredLamports: 5000, feeLamports: 5000 },
      binding: { scope: p.policy.scope, source: { lower: 0, upper: 20 }, target: null },
      instructionHash: "a".repeat(64),
      instructionNames: ["claim_fee2"],
      expiresAt: Date.now() + 20000,
    });
    render(<ConductorOperations mission={m} now={Date.now()} />);
    const prepare = await screen.findByRole("button", { name: "Prepare unsigned review" });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    expect(
      await screen.findByRole("button", { name: "Reserve budget & approve in wallet" }),
    ).toBeDisabled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(screen.getByText(/Connect the exact mission owner/)).toBeVisible();
  });
});

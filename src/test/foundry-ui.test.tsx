import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyFoundry } from "@/routes/app.foundry";
import { compileBlueprint, draftBlueprint } from "@/lib/foundry";
const m = vi.hoisted(() => ({
  read: vi.fn(),
  build: vi.fn(),
  fact: vi.fn(),
  save: vi.fn(),
  run: vi.fn(),
  list: vi.fn(),
  recheck: vi.fn(),
  wallet: {
    publicKey: { toBase58: () => "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD" } as {
      toBase58(): string;
    } | null,
  },
  settings: { cluster: "mainnet-beta", practice: false },
  pending: [] as unknown[],
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (c: unknown) => c,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { data: [] } }) }));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: { rpcEndpoint: "relay" } }),
  useWallet: () => m.wallet,
}));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({ settings: m.settings, hydrated: true }),
}));
vi.mock("@/components/wallet/WalletButton", () => ({
  WalletButton: () => <button>Connect wallet</button>,
}));
vi.mock("@/components/app/useTx", () => ({
  useTxRunner: () => ({
    canSign: !!m.wallet.publicKey,
    running: false,
    steps: null,
    reset: () => {},
    run: m.run,
  }),
  TxSteps: () => null,
}));
vi.mock("@/lib/tx", () => ({ browserPendingStore: { list: () => m.pending } }));
vi.mock("@/lib/foundry-chain", () => ({
  readFoundryPool: m.read,
  buildFoundryAction: m.build,
  revalidateFoundryAction: m.recheck,
}));
vi.mock("@/lib/foundry-store", () => ({
  listBlueprints: m.list,
  saveBlueprint: m.save,
  subscribeFoundry: () => () => {},
}));
vi.mock("@/lib/recorder-store", () => ({
  recordFact: m.fact,
  listRecords: async () => [],
  subscribeRecorder: () => () => {},
}));
const pair = {
  address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  mintX: "So11111111111111111111111111111111111111112",
  mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  binStep: 10,
};
const bp = {
  ...draftBlueprint(pair),
  liquidity: { ...draftBlueprint(pair).liquidity, budgetX: "0.001", budgetY: "0" },
};
const saved = { key: `${bp.id}:1`, blueprint: bp, digest: "a".repeat(64), savedAt: 1000 };
const snapshot = {
  ...pair,
  decimalsX: 9,
  decimalsY: 6,
  activeBinId: 100,
  enabled: true,
  activated: true,
  limitOrders: true,
  supportedMints: true,
  mintNotes: [],
  slot: 10,
  observedAt: 1000,
  baseFeeBps: 10,
  variableFeeBps: 0,
  totalFeeBps: 10,
  maxFeeBps: 500,
  protocolShareBps: 500,
  feeCurrency: "input",
};
function built(action = "liquidity") {
  return {
    blueprint: bp,
    digest: saved.digest,
    action,
    snapshot,
    compiled: compileBlueprint(bp, { activeBinId: 100, decimalsX: 9, decimalsY: 6 }),
    tx: {},
    signers: [],
    account: pair.address,
    newPosition: true,
    nativeWeights: [],
    simulatedAccountVerified: true,
    costs: {
      remaining: 0,
      feeLamports: 5000,
      requiredLamports: 10000,
      walletLamports: 1000000,
      solOutLamports: 10000,
      simErrors: [null],
      sizes: [700],
      units: [50000],
    },
    refusal: null,
  };
}
async function select() {
  const picker = await screen.findByLabelText("Immutable saved revisions");
  await waitFor(() => expect(picker.querySelectorAll("option").length).toBe(2));
  fireEvent.change(picker, { target: { value: saved.key } });
}
beforeEach(() => {
  m.wallet.publicKey = { toBase58: () => "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD" };
  m.settings.cluster = "mainnet-beta";
  m.settings.practice = false;
  m.pending = [];
  m.list.mockReset().mockResolvedValue([saved]);
  m.fact.mockReset().mockResolvedValue("review-foundry-1234");
  m.build.mockReset().mockImplementation(async (o) => built(o.action));
  m.read.mockReset().mockResolvedValue({ snapshot });
  m.recheck.mockReset().mockResolvedValue(null);
  m.run.mockReset().mockResolvedValue([{ phase: "confirmed" }]);
  m.save
    .mockReset()
    .mockResolvedValue({ ...saved, key: `${bp.id}:2`, blueprint: { ...bp, revision: 2 } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("Foundry UI approval boundaries", () => {
  it("lets a visitor select a blueprint but never prepares without a signing wallet", async () => {
    m.wallet.publicKey = null;
    render(<StrategyFoundry />);
    await select();
    expect(screen.getByRole("button", { name: "Review weighted liquidity" })).toBeDisabled();
    expect(m.build).not.toHaveBeenCalled();
  });
  it("blocks all chain work in practice and devnet rather than using fixtures", async () => {
    m.settings.practice = true;
    const ui = render(<StrategyFoundry />);
    await select();
    expect(screen.getByRole("button", { name: "Verify pool" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review weighted liquidity" })).toBeDisabled();
    m.settings.practice = false;
    m.settings.cluster = "devnet";
    ui.rerender(<StrategyFoundry />);
    expect(screen.getByRole("button", { name: "Verify pool" })).toBeDisabled();
    expect(m.read).not.toHaveBeenCalled();
  });
  it("requires a saved revision and discards a review immediately when a budget changes", async () => {
    render(<StrategyFoundry />);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Review weighted liquidity" }));
    expect(await screen.findByRole("button", { name: "Approve in wallet" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("SOL / WSOL budget · X"), {
      target: { value: "0.002" },
    });
    expect(screen.queryByRole("button", { name: "Approve in wallet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review weighted liquidity" })).toBeDisabled();
    expect(m.run).not.toHaveBeenCalled();
  });
  it("starts the review timer only after Recorder persistence finishes", async () => {
    let finish!: (id: string) => void;
    m.fact.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(<StrategyFoundry />);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Review weighted liquidity" }));
    await waitFor(() => expect(m.fact).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Approve in wallet" })).toBeNull();
    await act(async () => {
      finish("review-persisted-1234");
    });
    expect(await screen.findByRole("button", { name: "Approve in wallet" })).toBeEnabled();
    expect(m.fact.mock.calls[0]![0].context).toMatchObject({
      blueprintRevision: 1,
      blueprintDigest: saved.digest,
      simulatedAccountVerified: true,
    });
  });
  it("invalidates a build when its inputs change while the unabortable SDK call drains", async () => {
    let finish!: (x: ReturnType<typeof built>) => void;
    m.build.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<StrategyFoundry />);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Review weighted liquidity" }));
    await waitFor(() => expect(m.build).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Blueprint name"), {
      target: { value: "A changed route" },
    });
    await act(async () => {
      finish(built());
    });
    expect(screen.queryByRole("button", { name: "Approve in wallet" })).toBeNull();
    expect(m.fact).not.toHaveBeenCalled();
  });
  it("does not build a new action while the wallet has an unresolved signature", async () => {
    m.pending = [{ wallet: m.wallet.publicKey!.toBase58(), cluster: "mainnet-beta" }];
    render(<StrategyFoundry />);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Review weighted liquidity" }));
    expect(await screen.findByText(/Resolve the wallet's pending signature/)).toBeInTheDocument();
    expect(m.build).not.toHaveBeenCalled();
  });
  it("passes Recorder linkage, exact fee cap and both semantic guards to the shared runner", async () => {
    render(<StrategyFoundry />);
    await select();
    fireEvent.click(screen.getByRole("button", { name: "Review weighted liquidity" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve in wallet" }));
    await waitFor(() => expect(m.run).toHaveBeenCalled());
    const options = m.run.mock.calls[0]![1];
    expect(options.maxFeeLamports).toBe(bp.rules.maxNetworkFeeLamports);
    expect(options.evidence.links.reviewId).toBe("review-foundry-1234");
    expect(options.evidence.context.blueprintDigest).toBe(saved.digest);
    expect(options.semanticGuard).toBeTypeOf("function");
    expect(options.asyncSemanticGuard).toBeTypeOf("function");
    // An edit after the runner acquired the frozen review invalidates even a wallet approval already open.
    fireEvent.change(screen.getByLabelText("SOL / WSOL budget · X"), {
      target: { value: "0.002" },
    });
    expect(options.semanticGuard()).toMatch(/changed/);
  });
});

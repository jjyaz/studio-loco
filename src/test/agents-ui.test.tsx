import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "@/routes/app.agents";
import { DEFAULT_RULE, armRule, rulesStorageKey, type Rule } from "@/lib/agents";
import { browserPendingStore } from "@/lib/tx";

const mocks = vi.hoisted(() => ({ read: vi.fn(), vol: vi.fn(), rebalance: vi.fn(), withdraw: vi.fn(), run: vi.fn() }));
const owner = "So11111111111111111111111111111111111111112";
const position = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const second = "11111111111111111111111111111111";
const scope = rulesStorageKey(owner, "mainnet-beta", "relay");
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isPending: true }) }));
vi.mock("@solana/wallet-adapter-react", () => ({ useConnection: () => ({ connection: {} }), useWallet: () => ({ publicKey: { toBase58: () => "So11111111111111111111111111111111111111112" } }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ settings: { cluster: "mainnet-beta", rpc: {}, slippageBps: 50, practice: false } }) }));
vi.mock("@/components/wallet/WalletButton", () => ({ WalletButton: () => <button>Wallet</button> }));
vi.mock("@/components/app/useTx", () => ({ useTxRunner: () => ({ canSign: true, running: false, steps: null, run: mocks.run, reset: vi.fn() }), TxSteps: () => null, CheckStatus: () => <span>Check pending status</span> }));
vi.mock("@/components/app/positions", () => ({ fetchPositionRows: mocks.read }));
vi.mock("@/lib/agents-chain", () => ({ buildNativeRebalance: mocks.rebalance, buildWithdraw: mocks.withdraw, readVolatility: mocks.vol, discoverSamePair: vi.fn(), verifyStagedDestination: vi.fn() }));

const row = (activeId = 120, key = position) => ({ key, pair: owner, activeId, lower: 90, upper: 110, binStep: 25, mintX: owner, mintY: second, decX: 9, decY: 6, position: { positionData: { totalXAmount: "1000", totalYAmount: "1000", lowerBinId: 90, upperBinId: 110, positionBinData: [{ binId: 100, positionXAmount: "1000", positionYAmount: "1000" }] } } });
const seed = (rules: Record<string, Rule>) => localStorage.setItem(scope, JSON.stringify({ v: 1, rules }));
const armed = (patch: Partial<Rule> = {}) => armRule({ ...DEFAULT_RULE, ...patch }, 100, 25, Date.now());
beforeEach(() => { localStorage.clear(); mocks.read.mockReset().mockResolvedValue([row()]); mocks.vol.mockReset(); mocks.run.mockReset(); mocks.rebalance.mockReset(); mocks.withdraw.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Agents screen race and monitoring regressions", () => {
  it("cancels preparation on close and never reopens a late review", async () => {
    seed({ [position]: armed() }); render(<Agents />);
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    const prepare = await screen.findByRole("button", { name: "Prepare review" });
    let finish!: (r: ReturnType<typeof row>[]) => void;
    mocks.read.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    fireEvent.click(prepare);
    await screen.findByText("Preparing review");
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => { finish([row()]); });
    expect(screen.queryByText("Preparing review")).toBeNull();
    expect(mocks.rebalance).not.toHaveBeenCalled();
  });
  it("discards an in-flight check after editing a rule and preserves the edited revision", async () => {
    seed({ [position]: armed() }); render(<Agents />);
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    await screen.findByRole("button", { name: "Prepare review" });
    let finish!: (r: ReturnType<typeof row>[]) => void;
    mocks.read.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Edge buffer"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save parameters" }));
    await act(async () => { finish([row(200)]); });
    expect(screen.queryByRole("button", { name: "Prepare review" })).toBeNull();
    const saved = JSON.parse(localStorage.getItem(scope)!);
    expect(saved.rules[position]).toMatchObject({ armed: false, revision: 2, edgeBuffer: 4, baseline: null });
    expect(screen.getByRole("button", { name: "Arm at bin 120" })).toBeInTheDocument();
  });
  it("arms from a new chain read rather than a cached card", async () => {
    mocks.read.mockResolvedValueOnce([row(100)]).mockResolvedValueOnce([row(145)]);
    render(<Agents />); fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    const arm = await screen.findByRole("button", { name: "Arm at bin 100" }); fireEvent.click(arm);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(scope)!).rules[position].baseline.activeId).toBe(145));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("uses each position's own volatility window in the same pool", async () => {
    seed({ [position]: armed({ edgeBuffer: 0, volatility: { frame: "5m", candles: 12, thresholdPct: 1, withdrawPct: 20 } }), [second]: armed({ edgeBuffer: 0, volatility: { frame: "1h", candles: 24, thresholdPct: 1, withdrawPct: 30 } }) });
    mocks.read.mockResolvedValue([row(100), row(100, second)]);
    mocks.vol.mockImplementation(async (_p, _cluster, frame, candles) => ({ state: "ok", pct: frame === "5m" ? 0.2 : 2, candles, newestAt: Date.now() }));
    render(<Agents />); fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    await screen.findByRole("button", { name: "Prepare review" });
    expect(screen.getAllByRole("button", { name: "Prepare review" })).toHaveLength(1);
    expect(screen.getByText(/Reduce · withdraw 30%/)).toBeInTheDocument();
    expect(mocks.vol.mock.calls.map((c) => c.slice(2, 4))).toEqual([["5m", 12], ["1h", 24]]);
  });
  it("resets observed time even after a short pause and does not accrue manual checks", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    seed({ [position]: armed({ outMinutes: 1, outWithdrawPct: 40 }) }); render(<Agents />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start monitoring" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.click(screen.getByRole("button", { name: "Pause monitoring" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start monitoring" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText(/Reduce · withdraw 40%/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(/Reduce · withdraw 40%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause monitoring" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run check" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run check" })));
    expect(screen.queryByText(/Reduce · withdraw 40%/)).toBeNull();
  });
  it("blocks a new review from a pending signature restored after reload", async () => {
    seed({ [position]: armed() });
    browserPendingStore.put({ wallet: owner, cluster: "mainnet-beta", rpc: "custom", signature: "previous", blockhash: owner, lastValidBlockHeight: 100, label: "Previous withdrawal", createdAt: Date.now() });
    render(<Agents />); fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    fireEvent.click(await screen.findByRole("button", { name: "Prepare review" }));
    expect(await screen.findByText(/previous transaction's settlement is unresolved/)).toBeInTheDocument();
    expect(mocks.rebalance).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("starts the review's full 20 seconds after a slow successful native build", async () => {
    const start = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      seed({ [position]: armed() }); render(<Agents />);
      fireEvent.click(screen.getByRole("button", { name: "Run check" }));
      const prepare = await screen.findByRole("button", { name: "Prepare review" });
      let finish!: (r: unknown) => void;
      mocks.rebalance.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      fireEvent.click(prepare);
      await waitFor(() => expect(mocks.rebalance).toHaveBeenCalledOnce());
      clock.mockReturnValue(start + 25_000);
      await act(async () => finish({ ok: true, built: {
        kind: "atomic", txs: [{ label: "Native rebalance", tx: {} }], target: { lower: 110, upper: 130 }, activeId: 120, width: 21,
        withdrawn: { x: "1000", y: "1000" }, deposited: { x: "997", y: "998" }, walletOut: { x: "3", y: "2" },
        binArrayCost: 0, bitmapExtensionCost: 0, binArrayCount: 0, maxActiveBinSlippage: 1,
        costs: { feeLamports: 5000, perTxFee: [5000], solOutLamports: 5000, requiredLamports: 5000, walletLamports: 10_000_000,
          sizes: [800], units: [300_000], simErrors: [null], logs: [[]], remaining: 0 },
      } }));
      const approve = await screen.findByRole("button", { name: "Approve in wallet" });
      expect(approve).toBeEnabled();
      let finishRun!: (r: unknown[]) => void;
      mocks.run.mockReturnValue(new Promise((resolve) => { finishRun = resolve; })); fireEvent.click(approve);
      await waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
      const options = mocks.run.mock.calls[0]![1];
      expect(options.semanticGuard()).toBeNull();
      clock.mockReturnValue(start + 45_001);
      expect(options.semanticGuard()).toMatch(/expired/);
      await act(async () => finishRun([]));
    } finally { clock.mockRestore(); }
  });
});

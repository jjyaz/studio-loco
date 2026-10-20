import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ list: vi.fn(), user: "owner-a" as string | null, wallet: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD" as string | null }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: m.wallet ? { toBase58: () => m.wallet } : null }) }));
vi.mock("@/components/signal/account", () => ({ useCloudSession: () => ({ userId: m.user, ready: true }), AccountPanel: () => <div>Sign in for access</div> }));
vi.mock("@/components/wallet/WalletButton", () => ({ WalletButton: () => <button>Connect wallet</button> }));
vi.mock("@/lib/depot.functions", () => ({ listGatedReports: m.list }));
vi.mock("@/components/depot/shared", () => ({ ScoutReportView: ({ r }: { r: { id: string } }) => <div>{r.id}</div>, WalletProof: () => <div>Wallet proof control</div> }));
import { GatedReports } from "@/components/depot/GatedReports";
const result = () => ({ ok: true, reports: [{ id: "Protected research" }], balanceRaw: "1000000", slot: 1, wallet: m.wallet });
beforeEach(() => { m.user = "owner-a"; m.wallet = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD"; m.list.mockReset(); });
afterEach(cleanup);

describe("holder-only report interface", () => {
  it("requires a connected wallet before requesting protected data", () => {
    m.wallet = null; render(<GatedReports id="agent" />);
    expect(screen.getByRole("button", { name: "Check access with proven wallet" })).toBeDisabled();
    expect(m.list).not.toHaveBeenCalled();
  });
  it("binds the requested wallet and removes prior content immediately on account or wallet changes", async () => {
    m.list.mockImplementation(async () => result());
    const view = render(<GatedReports id="agent" />);
    fireEvent.click(screen.getByRole("button", { name: "Check access with proven wallet" }));
    await screen.findByText("Protected research");
    expect(m.list).toHaveBeenCalledWith({ data: { agentId: "agent", wallet: m.wallet } });
    m.user = "owner-b"; view.rerender(<GatedReports id="agent" />);
    expect(screen.queryByText("Protected research")).toBeNull();
    expect(screen.queryByText(/Access granted/)).toBeNull();
  });
  it("drops an old in-flight response even if the wallet changes away and back", async () => {
    let resolve!: (v: ReturnType<typeof result>) => void;
    m.list.mockReturnValue(new Promise(r => { resolve = r; }));
    const view = render(<GatedReports id="agent" />);
    fireEvent.click(screen.getByRole("button", { name: "Check access with proven wallet" }));
    const old = m.wallet;
    m.wallet = "So11111111111111111111111111111111111111112"; view.rerender(<GatedReports id="agent" />);
    m.wallet = old; view.rerender(<GatedReports id="agent" />);
    await act(async () => resolve(result()));
    expect(screen.queryByText("Protected research")).toBeNull();
  });
  it("renders access failures and refuses a mismatched proven-wallet response", async () => {
    m.list.mockResolvedValue({ ...result(), wallet: "another-wallet" });
    render(<GatedReports id="agent" />);
    fireEvent.click(screen.getByRole("button", { name: "Check access with proven wallet" }));
    await screen.findByText(/Proven wallet changed/);
    expect(screen.queryByText("Protected research")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Check access with proven wallet" })).toBeEnabled());
  });
});

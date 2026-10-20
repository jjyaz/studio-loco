import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proofMessage, type ProofChallenge } from "@/lib/depot-contracts";
const m = vi.hoisted(() => ({ ask: vi.fn(), verify: vi.fn(), sign: vi.fn(), pk: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD" }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: { toBase58: () => m.pk }, signMessage: m.sign }), useConnection: () => ({ connection: {} }) }));
vi.mock("@/lib/depot.functions", () => ({ requestWalletChallenge: m.ask, verifyWalletChallenge: m.verify }));
import { WalletProof } from "@/components/depot/shared";
const agentId = "00000000-0000-4000-8000-000000000001";
function challenge() {
  const c: ProofChallenge = { domain: window.location.host, agentId, purpose: "controller", wallet: m.pk, nonce: "ab".repeat(32), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  return { ok: true as const, challenge: c, message: proofMessage(c) };
}
beforeEach(() => { m.pk = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD"; m.ask.mockReset(); m.verify.mockReset(); m.sign.mockReset(); });
afterEach(cleanup);
describe("wallet control proof interface", () => {
  it("signs only the exact domain-bound text and verifies before success", async () => {
    const c = challenge(), done = vi.fn();
    m.ask.mockResolvedValue(c); m.sign.mockResolvedValue(new Uint8Array(64).fill(1)); m.verify.mockResolvedValue({ ok: true });
    render(<WalletProof agentId={agentId} purpose="controller" onVerified={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Prove wallet control" }));
    await screen.findByText(/Wallet .* proven/);
    expect(m.sign).toHaveBeenCalledWith(new TextEncoder().encode(c.message));
    expect(m.verify).toHaveBeenCalledOnce(); expect(done).toHaveBeenCalledWith(c.challenge.wallet);
  });
  it("refuses a changed wallet while the server challenge is in flight", async () => {
    const c = challenge(); let resolve!: (x: typeof c) => void;
    m.ask.mockReturnValue(new Promise(r => { resolve = r; }));
    const view = render(<WalletProof agentId={agentId} purpose="controller" onVerified={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Prove wallet control" }));
    m.pk = "So11111111111111111111111111111111111111112";
    view.rerender(<WalletProof agentId={agentId} purpose="controller" onVerified={vi.fn()} />);
    await act(async () => resolve(c));
    expect(m.sign).not.toHaveBeenCalled(); expect(m.verify).not.toHaveBeenCalled();
    expect(screen.getByText(/Wallet or agent changed/)).toBeInTheDocument();
  });
  it("rejects server text that is not the canonical wallet-control challenge", async () => {
    m.ask.mockResolvedValue({ ...challenge(), message: "Sign an unrelated message" });
    render(<WalletProof agentId={agentId} purpose="controller" onVerified={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Prove wallet control" }));
    await screen.findByText(/challenge does not match/);
    expect(m.sign).not.toHaveBeenCalled();
  });
});

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginMessage, type LoginChallenge } from "@/lib/depot-auth";
const m = vi.hoisted(() => ({ pk: "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD" as string | null, sign: vi.fn(), fetch: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ publicKey: m.pk ? { toBase58: () => m.pk } : null, signMessage: m.sign }) }));
vi.mock("@/components/wallet/WalletButton", () => ({ WalletButton: () => <button>Connect wallet</button> }));
import { DepotWalletSignIn, useDepotWalletSession, useDepotServerFn } from "@/components/depot/auth";
const id = "00000000-0000-4000-8000-000000000011", A = "6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD", B = "So11111111111111111111111111111111111111112";
const account = (wallet = A) => ({ id, wallet, expiresAt: new Date(Date.now()+43_200_000).toISOString() });
const response = (body: unknown) => ({ ok: true, json: async () => body });
const challenge = () => {
  const now = Date.now();
  const c: LoginChallenge = { wallet: m.pk!, domain: window.location.host, nonce: "a".repeat(64), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now+300_000).toISOString() };
  return { ok: true, challenge: c, message: loginMessage(c) };
};
beforeEach(() => { m.pk = A; m.sign.mockReset().mockResolvedValue(new Uint8Array(64).fill(1)); m.fetch.mockReset(); vi.stubGlobal("fetch", m.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("wallet-only Depot sign-in", () => {
  it("has no email/password/provider form and requires a connected wallet", () => {
    m.pk = null; render(<DepotWalletSignIn purpose="open the Depot" />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with Solana" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("signs the canonical challenge then requires a stored wallet-matching session", async () => {
    const c = challenge();
    m.fetch.mockResolvedValueOnce(response(c)).mockResolvedValueOnce(response({ ok: true, account: account() })).mockResolvedValueOnce(response({ ok: true, account: account() }));
    render(<DepotWalletSignIn purpose="open the Depot" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Solana" }));
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(3));
    expect(m.sign).toHaveBeenCalledWith(new TextEncoder().encode(c.message));
    const verification = m.fetch.mock.calls[1]!;
    expect(JSON.parse(verification[1].body)).toMatchObject({ wallet: A, nonce: c.challenge.nonce });
    expect(verification[1].credentials).toBe("same-origin");
    expect(screen.queryByText(/Couldn't sign in/)).toBeNull();
  });
  it("refuses unrelated challenge text before opening the signature request", async () => {
    m.fetch.mockResolvedValue(response({ ...challenge(), message: "unrelated" }));
    render(<DepotWalletSignIn purpose="open the Depot" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Solana" }));
    await screen.findByText(/challenge does not match/); expect(m.sign).not.toHaveBeenCalled();
  });
  it("drops a challenge if the wallet changes away and back while it loads", async () => {
    const c = challenge(); let resolve!: (v: unknown) => void;
    m.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
    const v = render(<DepotWalletSignIn purpose="open the Depot" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Solana" }));
    m.pk = B; v.rerender(<DepotWalletSignIn purpose="open the Depot" />);
    m.pk = A; v.rerender(<DepotWalletSignIn purpose="open the Depot" />);
    await act(async () => resolve(response(c)));
    expect(m.sign).not.toHaveBeenCalled(); expect(m.fetch).toHaveBeenCalledOnce();
  });
  it("drops a signature returned after the wallet changes", async () => {
    m.fetch.mockResolvedValue(response(challenge())); let resolve!: (v: Uint8Array) => void;
    m.sign.mockReturnValue(new Promise(r => { resolve = r; }));
    const v = render(<DepotWalletSignIn purpose="open the Depot" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Solana" }));
    await waitFor(() => expect(m.sign).toHaveBeenCalledOnce());
    m.pk = B; v.rerender(<DepotWalletSignIn purpose="open the Depot" />);
    await act(async () => resolve(new Uint8Array(64)));
    expect(m.fetch).toHaveBeenCalledOnce();
  });
  it("does not treat a successful signature as a login if the browser discards the session", async () => {
    m.fetch.mockResolvedValueOnce(response(challenge())).mockResolvedValueOnce(response({ ok: true, account: account() })).mockResolvedValueOnce(response({ ok: true, account: null }));
    render(<DepotWalletSignIn purpose="open the Depot" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Solana" }));
    await screen.findByText(/browser did not keep/);
  });
  it("hides the old principal immediately on disconnect and ignores late session responses", async () => {
    m.fetch.mockResolvedValue(response({ ok: true, account: account() }));
    const v = renderHook(() => useDepotWalletSession());
    await waitFor(() => expect(v.result.current.userId).toBe(id));
    let resolve!: (v: unknown) => void; m.fetch.mockReturnValue(new Promise(r => { resolve = r; }));
    m.pk = B; v.rerender(); expect(v.result.current.userId).toBeNull();
    m.pk = null; v.rerender(); expect(v.result.current.userId).toBeNull();
    await act(async () => resolve(response({ ok: true, account: account(B) })));
    expect(v.result.current.userId).toBeNull();
  });
  it("puts the connected wallet on protected calls, without accepting a caller's forged wallet header", async () => {
    const fn = vi.fn(async (_opts: any) => ({ ok: true }));
    const v = renderHook(() => useDepotServerFn(fn));
    await v.result.current({ data: { n: 1 }, headers: { "x-loco-depot-wallet": B } });
    expect(fn.mock.calls[0]![0].headers.get("x-loco-depot-wallet")).toBe(A);
    expect(fn.mock.calls[0]![0].data).toEqual({ n: 1 });
  });
});

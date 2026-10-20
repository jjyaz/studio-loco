import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { Btn, Notice, Panel } from "@/components/kit";
import { WalletButton } from "@/components/wallet/WalletButton";
import { DEPOT_WALLET_HEADER, LoginChallenge, WalletAccount, loginMessage, validLoginChallenge, type WalletAccount as Account } from "@/lib/depot-auth";

const EVENT = "studio-loco:depot-auth";
function notifyAuth() {
  window.dispatchEvent(new Event(EVENT));
  try { localStorage.setItem(EVENT, `${Date.now()}:${Math.random()}`); } catch { /* Same-tab event still works. No credentials are stored here. */ }
}
async function authRequest(action: string, wallet: string, data?: unknown) {
  const r = await fetch(`/api/public/depot/auth/${action}`, {
    method: data === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: { [DEPOT_WALLET_HEADER]: wallet, ...(data !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15_000),
  });
  const out = await r.json();
  if (!r.ok || !out.ok) throw new Error(out.error ?? "Wallet sign-in service unavailable. Try again.");
  return out;
}

/** Explicit connected-wallet scope on every protected function; never relies on a browser-supplied user UUID. */
export function useDepotServerFn<T extends (...args: any[]) => Promise<any>>(fn: T) {
  const run = useServerFn(fn), { publicKey } = useWallet();
  const pk = publicKey?.toBase58() ?? "";
  return useCallback((...args: Parameters<T>): ReturnType<T> => {
    const options = args[0] ?? {};
    const headers = new Headers(options.headers);
    headers.set(DEPOT_WALLET_HEADER, pk);
    return run(...([{ ...options, headers }, ...args.slice(1)] as Parameters<T>)) as ReturnType<T>;
  }, [run, pk]);
}

/** A late response, disconnected wallet or account switch cannot expose the previous workspace. */
export function useDepotWalletSession() {
  const { publicKey } = useWallet(), pk = publicKey?.toBase58() ?? "";
  const live = useRef({ pk, epoch: 0 });
  if (live.current.pk !== pk) live.current = { pk, epoch: live.current.epoch + 1 };
  const [state, setState] = useState<{ pk: string; epoch: number; account: Account | null; error?: string } | null>(null);
  useEffect(() => {
    let active = true, generation = 0;
    const epoch = live.current.epoch;
    const load = async () => {
      const gen = ++generation;
      setState(null);
      if (!pk) return;
      try {
        const r = await authRequest("session", pk);
        const a = r.account ? WalletAccount.parse(r.account) : null;
        if (a && (a.wallet !== pk || Date.parse(a.expiresAt) <= Date.now())) throw new Error("Wallet session changed. Sign in again.");
        if (active && gen === generation && live.current.pk === pk && live.current.epoch === epoch) setState({ pk, epoch, account: a });
      } catch (e) {
        if (active && gen === generation && live.current.pk === pk && live.current.epoch === epoch) setState({ pk, epoch, account: null, error: e instanceof Error ? e.message : "Wallet session unavailable." });
      }
    };
    const refresh = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const storage = (e: StorageEvent) => { if (e.key === EVENT) refresh(); };
    refresh();
    window.addEventListener(EVENT, refresh); window.addEventListener("focus", refresh); window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; generation++; window.removeEventListener(EVENT, refresh); window.removeEventListener("focus", refresh); window.removeEventListener("storage", storage); document.removeEventListener("visibilitychange", visible); };
  }, [pk]);
  const s = state?.pk === pk && state.epoch === live.current.epoch ? state : null;
  const account = s?.account && Date.parse(s.account.expiresAt) > Date.now() ? s.account : null;
  useEffect(() => {
    if (!account) return;
    const t = setTimeout(() => notifyAuth(), Math.max(1, Date.parse(account.expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [account]);
  return { ready: !pk || !!s, userId: account?.id ?? null, wallet: account?.wallet ?? null, account, error: s?.error };
}
export async function signOutDepot(wallet: string) {
  await authRequest("logout", wallet, {});
  notifyAuth();
}

export function DepotWalletSignIn({ purpose }: { purpose: string }) {
  const wallet = useWallet(), pk = wallet.publicKey?.toBase58() ?? "";
  const live = useRef({ pk, epoch: 0 });
  if (live.current.pk !== pk) live.current = { pk, epoch: live.current.epoch + 1 };
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => () => { live.current.epoch++; }, []);
  async function signIn() {
    if (!pk || !wallet.signMessage || busy) return;
    const epoch = live.current.epoch;
    const current = () => { if (live.current.pk !== pk || live.current.epoch !== epoch) throw new Error("Wallet changed during sign-in. Start again with the connected wallet."); };
    setBusy(true); setError(null);
    try {
      const r = await authRequest("challenge", pk, { wallet: pk });
      const c = LoginChallenge.parse(r.challenge);
      current();
      if (!validLoginChallenge(c, pk, window.location.host) || r.message !== loginMessage(c)) throw new Error("Sign-in challenge does not match this site and wallet.");
      const signature = await wallet.signMessage(new TextEncoder().encode(r.message));
      current();
      if (!validLoginChallenge(c, pk, window.location.host)) throw new Error("Sign-in request expired. Try again.");
      const v = await authRequest("verify", pk, { wallet: pk, nonce: c.nonce, signature: bs58.encode(signature) });
      current();
      const account = WalletAccount.parse(v.account);
      const kept = await authRequest("session", pk);
      current();
      if (account.wallet !== pk || !kept.account || kept.account.id !== account.id || kept.account.wallet !== pk) throw new Error("Your browser did not keep the wallet session. Open Studio Loco directly and try again.");
      notifyAuth();
    } catch (e) { if (live.current.epoch === epoch) setError(e instanceof Error ? e.message : "Wallet sign-in was cancelled."); }
    finally { if (live.current.epoch === epoch) setBusy(false); }
  }
  useEffect(() => { setBusy(false); setError(null); }, [pk]);
  return (
    <Panel tone="cobalt">
      <p className="station-code text-amber">Private wallet workspace</p>
      <h2 className="display mt-1 text-2xl">Sign in with your wallet to {purpose}.</h2>
      <p className="mt-2 max-w-xl text-sm text-cream/80">Connect your Solana wallet and sign a short message. Your wallet opens its own private agents and reports—no email or password. Signing in costs no SOL and does not approve a transaction.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <WalletButton />
        {pk && <Btn disabled={busy || !wallet.signMessage} onClick={() => void signIn()}>{busy ? "Confirm sign-in in your wallet…" : "Sign in with Solana"}</Btn>}
      </div>
      {pk && !wallet.signMessage && <p className="mt-2 text-sm text-cream/75">Choose a wallet that supports signing messages.</p>}
      <p className="mt-3 max-w-xl text-xs text-cream/65">Sign-in lasts up to 12 hours. Disconnecting hides this workspace. Each agent still needs its separate wallet-control proof, and financial actions require your approval.</p>
      {error && <div className="mt-3"><Notice tone="error" title="Couldn't sign in">{error}</Notice></div>}
    </Panel>
  );
}

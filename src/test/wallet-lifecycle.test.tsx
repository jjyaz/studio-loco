import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { useTxRunner } from "@/components/app/useTx";
import { browserPendingStore, GENESIS } from "@/lib/tx";
import { createTxCoordinator, txCoordinator } from "@/lib/tx-coordinator";

const env = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  connection: {} as Record<string, unknown>,
  settings: { cluster: "devnet", rpc: {} as Record<string, string> },
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: env.connection }),
  useWallet: () => env.wallet,
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ settings: env.settings }) }));

const payer = Keypair.generate();
const fresh = () =>
  new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  );
function rpc() {
  return {
    getGenesisHash: vi.fn().mockResolvedValue(GENESIS["devnet"]),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
    sendRawTransaction: vi.fn().mockResolvedValue("signature"),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue({ value: [{ slot: 12, confirmationStatus: "confirmed", err: null }] }),
  };
}
function deferredSigner() {
  let approve!: () => void;
  let reject!: () => void;
  const sign = vi.fn(
    (tx: Transaction) =>
      new Promise<Transaction>((resolve, decline) => {
        approve = () => {
          tx.partialSign(payer);
          resolve(tx);
        };
        reject = () => decline(new Error("User rejected the request"));
      }),
  );
  env.wallet = { publicKey: payer.publicKey, signTransaction: sign };
  return { sign, approve: () => approve(), reject: () => reject() };
}

// jsdom's Uint8Array is a different realm from Node's Buffer. web3's binary
// layout checks need the native superclass used by Buffer during these tests.
beforeEach(() => {
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer.prototype).constructor);
  localStorage.clear();
  env.settings = { cluster: "devnet", rpc: {} };
  env.connection = rpc();
});
afterEach(() => {
  expect(txCoordinator.getSnapshot()).toBeNull();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("wallet approval lifecycle through the real shared runner", () => {
  it("discards approval after the initiating page unmounts, then releases the global slot", async () => {
    const w = deferredSigner();
    const hook = renderHook(() => useTxRunner());
    let work!: ReturnType<typeof hook.result.current.run>;
    act(() => {
      work = hook.result.current.run([{ label: "Native review", tx: fresh() }]);
    });
    await waitFor(() => expect(w.sign).toHaveBeenCalledOnce());
    hook.unmount();
    w.approve();
    const steps = await work;
    expect(steps[0]?.error).toMatch(/page was closed/);
    expect(env.connection["sendRawTransaction"]).not.toHaveBeenCalled();
    expect(browserPendingStore.list()).toEqual([]);
  });

  it.each(["wallet", "network", "rpc"])(
    "cannot revive a review after a %s changes away and back",
    async (change) => {
      const w = deferredSigner();
      const hook = renderHook(() => useTxRunner());
      let work!: ReturnType<typeof hook.result.current.run>;
      act(() => {
        work = hook.result.current.run([{ label: "Review", tx: fresh() }]);
      });
      await waitFor(() => expect(w.sign).toHaveBeenCalledOnce());
      if (change === "wallet") env.wallet["publicKey"] = Keypair.generate().publicKey;
      if (change === "network") env.settings.cluster = "mainnet-beta";
      if (change === "rpc") env.settings.rpc["devnet"] = "https://example.test/rpc";
      hook.rerender();
      env.wallet["publicKey"] = payer.publicKey;
      env.settings = { cluster: "devnet", rpc: {} };
      hook.rerender();
      await act(async () => {
        w.approve();
        await work;
      });
      expect(hook.result.current.steps?.[0]?.error).toMatch(/changed after/);
      expect(env.connection["sendRawTransaction"]).not.toHaveBeenCalled();
      hook.unmount();
    },
  );

  it("blocks a second mounted page while an approval is pending, and unlocks on explicit rejection", async () => {
    const w = deferredSigner();
    const first = renderHook(() => useTxRunner());
    const second = renderHook(() => useTxRunner());
    let work!: ReturnType<typeof first.result.current.run>;
    act(() => {
      work = first.result.current.run([{ label: "First approval", tx: fresh() }]);
    });
    await waitFor(() => expect(w.sign).toHaveBeenCalledOnce());
    expect(second.result.current.running).toBe(true);
    await expect(second.result.current.run([{ label: "Another", tx: fresh() }])).rejects.toThrow(
      /Another wallet action/,
    );
    await act(async () => {
      w.reject();
      await work;
    });
    expect(first.result.current.steps?.[0]?.phase).toBe("rejected");
    expect(second.result.current.running).toBe(false);
    expect(env.connection["sendRawTransaction"]).not.toHaveBeenCalled();
    first.unmount();
    second.unmount();
  });

  it("blocks a restored unresolved signature before any RPC or wallet prompt, even from another RPC", async () => {
    const w = deferredSigner();
    browserPendingStore.put({
      wallet: payer.publicKey.toBase58(),
      cluster: "devnet",
      rpc: "custom",
      signature: "previous-unresolved",
      blockhash: payer.publicKey.toBase58(),
      lastValidBlockHeight: 100,
      createdAt: Date.now(),
      label: "Prior action",
    });
    const hook = renderHook(() => useTxRunner());
    await act(async () => {
      await hook.result.current.run([{ label: "Fresh action", tx: fresh() }]);
    });
    expect(hook.result.current.steps?.[0]?.error).toMatch(/unresolved transaction/);
    expect(env.connection["getLatestBlockhash"]).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled();
    expect(browserPendingStore.list()).toHaveLength(1);
    hook.unmount();
  });

  it("keeps confirmation alive after navigation when broadcasting already happened", async () => {
    env.wallet = {
      publicKey: payer.publicKey,
      signTransaction: vi.fn(async (tx: Transaction) => {
        tx.partialSign(payer);
        return tx;
      }),
    };
    let resolve!: (v: unknown) => void;
    env.connection["getSignatureStatuses"] = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const hook = renderHook(() => useTxRunner());
    let work!: ReturnType<typeof hook.result.current.run>;
    act(() => {
      work = hook.result.current.run([{ label: "Already sent", tx: fresh() }]);
    });
    await waitFor(() => expect(env.connection["getSignatureStatuses"]).toHaveBeenCalledOnce());
    hook.unmount();
    expect(browserPendingStore.list()).toHaveLength(1);
    resolve({ value: [{ slot: 55, confirmationStatus: "confirmed", err: null }] });
    const steps = await work;
    expect(steps[0]?.phase).toBe("confirmed");
    expect(browserPendingStore.list()).toEqual([]);
    expect(env.connection["sendRawTransaction"]).toHaveBeenCalledOnce();
  });
});

describe("transaction coordination ownership", () => {
  it("an old lease cannot release or update a later transaction", () => {
    const c = createTxCoordinator();
    const change = vi.fn();
    const unsubscribe = c.subscribe(change);
    const old = c.acquire({ wallet: "a", cluster: "devnet", label: "Old" });
    old.release();
    const current = c.acquire({ wallet: "b", cluster: "devnet", label: "New" });
    old.release();
    old.update("Old", "failed");
    expect(c.getSnapshot()?.label).toBe("New");
    current.release();
    unsubscribe();
    expect(change).toHaveBeenCalledTimes(4);
  });
});

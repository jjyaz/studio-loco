import type { TxPhase } from "./tx";

export interface ActiveTransaction {
  wallet: string;
  cluster: string;
  label: string;
  phase: TxPhase;
}

/** A single browser-wide approval/settlement slot, shared across mounted pages. */
export function createTxCoordinator() {
  let active: ActiveTransaction | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(scope: Omit<ActiveTransaction, "phase">) {
      if (active)
        throw new Error(
          "Another wallet action is still in progress. Finish or decline its approval, then wait for its status.",
        );
      let held = true;
      active = { ...scope, phase: "preparing" };
      notify();
      return {
        update(label: string, phase: TxPhase) {
          if (!held) return;
          active = { ...scope, label, phase };
          notify();
        },
        release() {
          if (!held) return;
          held = false;
          active = null;
          notify();
        },
      };
    },
  };
}

export const txCoordinator = createTxCoordinator();
export const noServerTransaction = () => null;

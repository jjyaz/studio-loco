import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Frozen, identity-bound prepared plans (reviews / quotes).
 * A plan is only "current" while its identity key (wallet, cluster, RPC, inputs,
 * preset, slippage…) equals the live form key. Async builds started under an old key,
 * or superseded by a newer build, are discarded. Displayed review values come from the
 * frozen plan, never from the mutable form.
 */
export function planKey(parts: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k] === undefined ? null : String(parts[k])]));
}

export function usePlan<T>(liveKey: string) {
  const [plan, setPlanState] = useState<{ key: string; value: T } | null>(null);
  const seq = useRef(0);
  const liveRef = useRef(liveKey);
  liveRef.current = liveKey;

  // Invalidate as soon as identity changes; also abandon in-flight builds.
  useEffect(() => {
    seq.current++;
    setPlanState((p) => (p && p.key !== liveKey ? null : p));
  }, [liveKey]);

  /** Start a build; returns a commit function that only lands if still current. */
  const begin = useCallback(() => {
    const id = ++seq.current;
    const key = liveRef.current;
    setPlanState(null);
    return {
      isCurrent: () => id === seq.current && key === liveRef.current,
      commit: (value: T) => {
        if (id !== seq.current || key !== liveRef.current) return false;
        setPlanState({ key, value });
        return true;
      },
    };
  }, []);

  const clear = useCallback(() => { seq.current++; setPlanState(null); }, []);
  const current = plan && plan.key === liveKey ? plan.value : null;
  return { plan: current, begin, clear };
}

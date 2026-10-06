import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Cluster = "mainnet-beta" | "devnet";

export interface Settings {
  cluster: Cluster;
  /** custom HTTPS RPC per cluster; empty = public default */
  rpc: Record<Cluster, string>;
  slippageBps: number;
  practice: boolean;
}

export const DEFAULT_RPC: Record<Cluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};
export const SLIPPAGE_PRESETS = [10, 50, 100, 300];

const DEFAULTS: Settings = { cluster: "mainnet-beta", rpc: { "mainnet-beta": "", devnet: "" }, slippageBps: 50, practice: false };
const KEY = "studio-loco:settings:v1";

export function validateRpc(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "RPC endpoint must use HTTPS";
    return null;
  } catch {
    return "Not a valid URL";
  }
}

interface Ctx {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  endpoint: string;
  hydrated: boolean;
}
const SettingsCtx = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Settings>;
        setSettings({ ...DEFAULTS, ...s, rpc: { ...DEFAULTS.rpc, ...(s.rpc ?? {}) } });
      }
    } catch {
      /* ignore corrupt settings */
    }
    setHydrated(true);
  }, []);
  const update = (p: Partial<Settings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  const endpoint = useMemo(() => {
    const custom = settings.rpc[settings.cluster];
    if (custom && !validateRpc(custom)) return custom;
    // Public RPCs reject browser origins; use the app's narrow relay to the public endpoint.
    if (hydrated && typeof window !== "undefined") return `${window.location.origin}/api/public/rpc/${settings.cluster === "devnet" ? "devnet" : "mainnet"}`;
    return DEFAULT_RPC[settings.cluster];
  }, [settings, hydrated]);
  return <SettingsCtx.Provider value={{ settings, update, endpoint, hydrated }}>{children}</SettingsCtx.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setV(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
  }, [key]);
  const set = (nv: T | ((p: T) => T)) =>
    setV((prev) => {
      const next = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  return [v, set];
}

export function useStars() {
  const [stars, setStars] = useLocalState<string[]>("studio-loco:stars:v1", []);
  return {
    stars,
    isStarred: (a: string) => stars.includes(a),
    toggle: (a: string) => setStars((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a])),
  };
}

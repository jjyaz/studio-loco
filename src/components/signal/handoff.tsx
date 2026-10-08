import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Btn, Notice } from "@/components/kit";
import { loadSignalHandoff, type SignalHandoff } from "@/lib/signal-handoff";

export function useSignalHandoff(id: string | undefined, kind: "position" | "arb") {
  const [data, setData] = useState<SignalHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const reload = useCallback(async () => {
    const gen = ++epoch.current;
    setData(null);
    setError(null);
    if (!id) return null;
    setLoading(true);
    try {
      const h = await loadSignalHandoff(id, kind);
      if (gen === epoch.current) setData(h);
      return gen === epoch.current ? h : null;
    } catch (e) {
      if (gen === epoch.current)
        setError(e instanceof Error ? e.message : "Couldn't load this alert.");
      return null;
    } finally {
      if (gen === epoch.current) setLoading(false);
    }
  }, [id, kind]);
  useEffect(() => {
    if (!id) return;
    let off = () => {},
      mounted = true;
    void reload();
    void import("@/integrations/supabase/client").then(({ supabase }) => {
      if (!mounted) return;
      const { data: auth } = supabase.auth.onAuthStateChange((event) => {
        if (["SIGNED_OUT", "SIGNED_IN", "USER_UPDATED"].includes(event)) {
          epoch.current++;
          setData(null);
          setLoading(false);
          setError("Workspace changed. Load the alert again to verify its owner and revision.");
        }
      });
      off = () => auth.subscription.unsubscribe();
    });
    return () => {
      mounted = false;
      // This is a request generation counter, not a DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++;
      off();
    };
  }, [id, reload]);
  return { data, error, loading, reload };
}

export function HandoffNotice({
  id,
  state,
  applied,
  blocked,
  onApply,
}: {
  id: string | undefined;
  state: ReturnType<typeof useSignalHandoff>;
  applied: boolean;
  blocked?: string | null;
  onApply: () => void;
}) {
  if (!id) return null;
  return (
    <div className="mb-4">
      <Notice tone={state.error ? "error" : "info"} title="Signal Box → fresh review">
        <p>
          {state.loading
            ? "Checking this private alert and the current watch revision…"
            : (state.error ??
              (applied
                ? "Watch rules loaded. Read chain state again; the old alert is an observation, and its original opportunity may have passed."
                : "Load this watch's verified rules, then make a fresh chain check. Alert payloads never supply a transaction to sign."))}
        </p>
        {blocked && <p className="mt-2">{blocked}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {state.data && !applied ? (
            <Btn size="sm" onClick={onApply} disabled={!!blocked}>
              Load watch rules
            </Btn>
          ) : (
            <Btn
              size="sm"
              variant="line"
              onClick={() => void state.reload()}
              disabled={state.loading}
            >
              {state.loading ? "Checking…" : "Reload private alert"}
            </Btn>
          )}
          <Link to="/app/signal-box" className="station-code self-center underline">
            Open Signal Box
          </Link>
        </div>
      </Notice>
    </div>
  );
}

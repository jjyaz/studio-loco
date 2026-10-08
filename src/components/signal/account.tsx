import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Btn, Field, Notice, Panel } from "@/components/kit";

/** Browser-only session hook for the private Signal Box / Recorder cloud workspace. */
export function useCloudSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let off = () => {};
    void import("@/integrations/supabase/client").then(({ supabase }) => {
      supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
      const { data } = supabase.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_IN" || ev === "SIGNED_OUT" || ev === "USER_UPDATED" || ev === "TOKEN_REFRESHED") setSession(s); });
      off = () => data.subscription.unsubscribe();
    });
    return () => off();
  }, []);
  return { session, ready, userId: session?.user.id ?? null, email: session?.user.email ?? null };
}

export async function signOut() {
  const { supabase } = await import("@/integrations/supabase/client");
  await supabase.auth.signOut();
}

/** Account connection: email + password or Google. This is a private cloud workspace — never a wallet login. */
export function AccountPanel({ purpose }: { purpose: string }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      if (mode === "up") {
        const { data, error } = await supabase.auth.signUp({ email, password: pw, options: { emailRedirectTo: `${window.location.origin}/app/signal-box` } });
        if (error) throw error;
        setMsg({ tone: "info", text: data.session ? "Account created." : "Check your email to confirm the account, then sign in." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      }
    } catch (err) { setMsg({ tone: "error", text: err instanceof Error ? err.message : "Sign-in failed" }); }
    finally { setBusy(false); }
  }
  async function google() {
    setBusy(true); setMsg(null);
    try {
      const { lovable } = await import("@/integrations/lovable");
      const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin + window.location.pathname });
      if (r && "error" in r && r.error) setMsg({ tone: "error", text: String((r.error as Error).message ?? r.error) });
    } finally { setBusy(false); }
  }
  return (
    <Panel tone="cobalt">
      <p className="station-code text-amber">Private workspace</p>
      <h2 className="display mt-1 text-2xl">Sign in to {purpose}.</h2>
      <p className="mt-2 max-w-xl text-sm text-cream/80">This account only stores your watch rules, alerts and optional recorder copy. It is not your wallet: Studio Loco never asks for a seed phrase or private key, and nothing can sign on your behalf.</p>
      <form onSubmit={submit} className="mt-4 grid max-w-md gap-3">
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete={mode === "up" ? "new-password" : "current-password"} required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Btn type="submit" disabled={busy}>{busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}</Btn>
          <Btn type="button" variant="line" disabled={busy} onClick={google}>Continue with Google</Btn>
          <Btn type="button" variant="ghost" onClick={() => setMode(mode === "in" ? "up" : "in")}>{mode === "in" ? "New here? Create account" : "Have an account? Sign in"}</Btn>
        </div>
      </form>
      {msg && <div className="mt-3"><Notice tone={msg.tone} title={msg.tone === "error" ? "Couldn't sign in" : "Almost there"}>{msg.text}</Notice></div>}
    </Panel>
  );
}

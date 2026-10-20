import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createStart: (fn: () => unknown) => fn(), createCsrfMiddleware: () => ({}),
  createMiddleware: () => ({ client: (fn: unknown) => fn, server: (fn: unknown) => fn }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: { getSession: m.getSession } } }));
import { startInstance } from "@/start";
const run = (startInstance as unknown as { functionMiddleware: ((v: unknown) => Promise<unknown>)[] }).functionMiddleware[0]!;
beforeEach(() => { m.getSession.mockReset(); });
describe("authentication client transport separation", () => {
  it("lets a wallet-authenticated Depot call reach its own server authenticator without email auth storage", async () => {
    let called = 0; const next = async () => { called++; };
    m.getSession.mockRejectedValue(new Error("Legacy auth storage unavailable"));
    const h = new Headers({ "x-loco-depot-wallet": "wallet" });
    await run({ next, headers: h });
    expect(called).toBe(1); expect(m.getSession).not.toHaveBeenCalled();
  });
  it("preserves the existing token transport for other authenticated workspaces", async () => {
    let seen: unknown; const next = async (v: unknown) => { seen = v; }; m.getSession.mockResolvedValue({ data: { session: { access_token: "legacy-token" } } });
    await run({ next }); expect(seen).toEqual({ headers: { Authorization: "Bearer legacy-token" } });
  });
});

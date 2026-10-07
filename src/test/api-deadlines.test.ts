// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "@/lib/meteora-api";

afterEach(() => vi.useRealTimers());
describe("public data request deadlines", () => {
  it.each(["headers", "body"])(
    "times out stalled %s even if the implementation ignores cancellation",
    async (stage) => {
      vi.useFakeTimers();
      const stalled = new Promise<never>(() => {});
      const impl = vi.fn(() =>
        stage === "headers"
          ? stalled
          : Promise.resolve({ ok: true, status: 200, json: () => stalled } as unknown as Response),
      );
      const work = fetchJson("https://example.test", {
        fetchImpl: impl as typeof fetch,
        retries: 0,
        timeoutMs: 100,
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await work).toMatchObject({ kind: "timeout" });
      expect(impl).toHaveBeenCalledOnce();
    },
  );
  it("caller cancellation during body consumption reports cancellation and never retries", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const impl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: () => {
            entered();
            return new Promise<never>(() => {});
          },
        }) as unknown as Response,
    );
    const work = fetchJson("https://example.test", {
      fetchImpl: impl as typeof fetch,
      signal: controller.signal,
    }).catch((error) => error);
    await bodyEntered;
    controller.abort();
    expect(await work).toMatchObject({ kind: "aborted" });
    expect(impl).toHaveBeenCalledOnce();
  });
  it("a genuinely malformed body remains a parse error", async () => {
    const impl = vi.fn(async () => new Response("not JSON"));
    await expect(
      fetchJson("https://example.test", { fetchImpl: impl as typeof fetch, retries: 0 }),
    ).rejects.toMatchObject({ kind: "parse" });
  });
});

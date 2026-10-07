// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRpcFetch } from "@/lib/rpc-fetch";

afterEach(() => vi.useRealTimers());

describe("RPC transport deadlines", () => {
  it("aborts a hung response body so an SDK job can drain", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_input, init) => ({
      status: 200, statusText: "OK", headers: new Headers(),
      arrayBuffer: () => new Promise<ArrayBuffer>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    } as Response)) as unknown as typeof fetch;
    const work = createRpcFetch(fetcher, 1000)("https://example.test/rpc");
    const rejection = expect(work).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
  });
  it("honors cancellation by its caller rather than waiting for the deadline", async () => {
    const upstream = new AbortController();
    const fetcher = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })) as unknown as typeof fetch;
    const work = createRpcFetch(fetcher)("https://example.test/rpc", { signal: upstream.signal });
    const rejection = expect(work).rejects.toMatchObject({ name: "AbortError" });
    upstream.abort();
    await rejection;
  });
  it("preserves error status and retry headers for explicit handling", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429, headers: { "retry-after": "3" } })) as typeof fetch;
    const response = await createRpcFetch(fetcher)("https://example.test/rpc");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.json()).toEqual({ error: "rate limited" });
  });
});

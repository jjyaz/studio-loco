/** Bound headers AND body reads. A timed-out SDK call must eventually drain. */
export const RPC_TIMEOUT_MS = 15_000;

export function createRpcFetch(fetchImpl: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const control = new AbortController();
    const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const cancel = () => control.abort(upstream?.reason);
    if (upstream?.aborted) cancel();
    else upstream?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => control.abort(new DOMException("RPC request timed out", "TimeoutError")), timeoutMs);
    try {
      const response = await fetchImpl(input, { ...init, signal: control.signal });
      const bytes = await response.arrayBuffer();
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", cancel);
    }
  };
}

export const rpcFetch = createRpcFetch();

import type { z } from "zod";
import {
  AddressSchema,
  CapabilitiesSchema,
  DEFAULT_BASE_URL,
  ErrorSchema,
  PoolListSchema,
  PoolQuerySchema,
  PoolSchema,
  PositionSchema,
  envelope,
  type PoolQuery,
  type Snapshot,
} from "./contracts.js";

export class LocoError extends Error {
  override name = "LocoError";
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public retryable = false,
  ) {
    super(message);
  }
}
/** Bounded streaming read. A caller supplies the end-to-end deadline. */
export async function readJsonLimited(
  response: Response,
  maxBytes = 2_000_000,
  signal?: AbortSignal,
): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel();
    throw new LocoError("response-too-large", "Response exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LocoError("invalid-response", "Empty response body");
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let completed = false;
  let size = 0,
    text = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new LocoError("aborted", "Request cancelled");
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      size += value.byteLength;
      if (size > maxBytes)
        throw new LocoError("response-too-large", "Response exceeds the size limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new LocoError("invalid-response", "Response is not JSON");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Cancellation may still own the lock in a Worker runtime. */
    }
  }
}
export type ReadOptions = { signal?: AbortSignal };
export type LocoClientOptions = { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number };
export class LocoClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  constructor(options: LocoClientOptions = {}) {
    const url = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new LocoError("invalid-input", "Use an HTTPS API URL or local development server");
    this.baseUrl = url.href.replace(/\/$/, "");
    // Browser fetch checks its receiver; invoking it as this.fetchImpl is otherwise illegal.
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000)
      throw new LocoError("invalid-input", "Timeout must be between 1 and 60000 ms");
  }
  private async read<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    options: ReadOptions = {},
  ): Promise<Snapshot<z.infer<T>>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new LocoError("aborted", "Request cancelled"));
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new LocoError("timeout", "Loco request timed out", undefined, true));
      }, this.timeoutMs);
    });
    const work = async () => {
      if (controller.signal.aborted) throw new LocoError("aborted", "Request cancelled");
      const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        signal: controller.signal,
        ...(typeof location !== "undefined" ? { credentials: "omit" as const } : {}),
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      const body = await readJsonLimited(response, 2_000_000, controller.signal);
      if (!response.ok) {
        const error = ErrorSchema.safeParse(body);
        if (!error.success)
          throw new LocoError("invalid-response", "Invalid error envelope", response.status);
        throw new LocoError(
          error.data.error.code,
          error.data.error.message,
          response.status,
          error.data.error.retryable,
        );
      }
      const parsed = envelope(schema).safeParse(body);
      if (!parsed.success)
        throw new LocoError(
          "invalid-response",
          "Response does not match Loco API v1",
          response.status,
        );
      return parsed.data as Snapshot<z.infer<T>>;
    };
    try {
      return await Promise.race([work(), stopped]);
    } catch (e) {
      if (e instanceof LocoError) throw e;
      throw new LocoError("network", "Unable to reach Loco API", undefined, true);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
  capabilities(options?: ReadOptions) {
    return this.read("capabilities", CapabilitiesSchema, options);
  }
  listPools(query: PoolQuery = {}, options?: ReadOptions) {
    const parsed = PoolQuerySchema.safeParse(query);
    if (!parsed.success) throw new LocoError("invalid-input", "Invalid pool query");
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed.data))
      if (v !== undefined && v !== "") params.set(k, String(v));
    return this.read(`pools?${params}`, PoolListSchema, options);
  }
  getPool(address: string, options?: ReadOptions) {
    if (!AddressSchema.safeParse(address).success)
      throw new LocoError("invalid-input", "Invalid pool address");
    return this.read(`pools/${address}`, PoolSchema, options);
  }
  getPosition(address: string, pool: string, options?: ReadOptions) {
    if (![address, pool].every((a) => AddressSchema.safeParse(a).success))
      throw new LocoError("invalid-input", "Invalid position or pool address");
    return this.read(`positions/${address}?pool=${pool}`, PositionSchema, options);
  }
}

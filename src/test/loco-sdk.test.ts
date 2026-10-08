// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocoClient,
  LocoError,
  isAddress,
  planRange,
  analyzeRecorderExport,
  readJsonLimited,
} from "../../packages/sdk/src/index";
import { handleLocoRequest } from "../lib/loco-http.server";
import { publicPool, verifiedAccount, withLocoBudget } from "../lib/loco-api.server";
import { exportBundle, RecordSchema } from "../lib/recorder";
import { Buffer } from "buffer";
const base = "https://studioloco.cfd/api/public/loco/v1";
const pool = "So11111111111111111111111111111111111111112";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const rpc = (method: string, params?: object, headers?: HeadersInit) =>
  new Request(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
async function rpcJson(r: Response) {
  const text = await r.text();
  return JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .find((s) => s.startsWith("data: "))!
          .slice(6)
      : text,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Loco SDK contract and bounded reads", () => {
  it("validates decoded 32-byte addresses including PDAs and rejects superficially valid base58", () => {
    expect(isAddress(pool)).toBe(true);
    expect(isAddress("11111111111111111111111111111111")).toBe(true);
    expect(isAddress("2".repeat(32))).toBe(false);
    expect(isAddress("1".repeat(44))).toBe(false);
  });
  it("instantiated client reads the deployed handler's envelope and strips additive fields", async () => {
    const loco = new LocoClient({
      fetch: async () => handleLocoRequest(new Request(`${base}/capabilities`)),
    });
    const r = await loco.capabilities();
    expect(r.meta.cluster).toBe("mainnet-beta");
    expect(r.data.readOnly).toBe(true);
  });
  it("rejects wrong versions, clusters, malformed errors and malformed JSON", async () => {
    const valid = await (await handleLocoRequest(new Request(`${base}/capabilities`))).json();
    for (const meta of [
      { ...valid.meta, apiVersion: "2" },
      { ...valid.meta, cluster: "devnet" },
    ])
      await expect(
        new LocoClient({ fetch: async () => Response.json({ ...valid, meta }) }).capabilities(),
      ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      new LocoClient({
        fetch: async () => Response.json({ message: "broken" }, { status: 502 }),
      }).capabilities(),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      new LocoClient({ fetch: async () => new Response("<html>bad") }).capabilities(),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("does not fetch when input is invalid or already aborted", async () => {
    const fetch = vi.fn();
    const loco = new LocoClient({ fetch });
    expect(() => loco.listPools({ perPage: 1000 })).toThrow(LocoError);
    expect(() => loco.getPool("../../private")).toThrow();
    const c = new AbortController();
    c.abort();
    await expect(loco.capabilities({ signal: c.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("deadline covers fetch implementations which ignore abort", async () => {
    vi.useFakeTimers();
    const p = new LocoClient({ timeoutMs: 100, fetch: () => new Promise(() => {}) }).capabilities();
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await check;
  });
  it("deadline cancels a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const p = new LocoClient({
      timeoutMs: 100,
      fetch: async () => new Response(body),
    }).capabilities();
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await check;
    expect(cancel).toHaveBeenCalled();
  });
  it("caps actual streamed bytes and rejects credential-bearing API URLs", async () => {
    await expect(readJsonLimited(new Response("1234567890"), 3)).rejects.toMatchObject({
      code: "response-too-large",
    });
    expect(() => new LocoClient({ baseUrl: "https://token:secret@evil.example/api" })).toThrow();
    expect(() => new LocoClient({ baseUrl: "http://evil.example/api" })).toThrow();
  });
});
describe("Local planning and shared Flight Recorder evidence", () => {
  it("preserves exact even/odd width and labels geometry as non-executable", () => {
    expect(planRange({ lower: -10, upper: 9, active: 12 }).options[1]).toMatchObject({
      lower: 2,
      upper: 21,
      width: 20,
    });
    expect(planRange({ lower: -10, upper: 10, active: 12 }).options[1]).toMatchObject({
      lower: 2,
      upper: 22,
      width: 21,
    });
    expect(planRange({ lower: 0, upper: 1, active: 5 })).toMatchObject({
      executable: false,
      simulation: false,
    });
    expect(() => planRange({ lower: 0, upper: 69, active: 5 })).toThrow();
    expect(() =>
      planRange({ lower: 0, upper: 9, active: 5, widen: { lower: 1, upper: 11 } }),
    ).toThrow();
  });
  it("uses the app schema; rejects invalid records and exposes aggregate counts without raw private text", () => {
    const record = RecordSchema.parse({
      v: 1,
      id: "record-test-001",
      kind: "wallet-action",
      provenance: "this-device",
      createdAt: 1,
      updatedAt: 1,
      route: "/app",
      cluster: "mainnet-beta",
      rpc: "relay",
      wallet: pool,
      title: "secret=user-secret https://private.example",
      status: "confirmed",
      links: { recordId: "missing-id" },
      context: {},
      steps: [],
      timeline: [],
      postState: [],
    });
    const bundle = exportBundle([record]);
    bundle.records.push(record, { ...record, id: "bad" });
    const summary = analyzeRecorderExport(bundle);
    expect(summary).toMatchObject({
      accepted: 1,
      duplicates: 1,
      rejected: 1,
      inconsistentConfirmations: 1,
      danglingRecordLinks: 1,
      chainVerified: false,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain(pool);
  });
});
describe("Public API boundaries and genuine MCP", () => {
  it("rejects unknown/repeated query keys, mutation routes, invalid positions and generic RPC", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const p of [
      "pools?perPage=100",
      "pools?rpcUrl=https://evil.example",
      "pools?page=1&page=2",
      "positions/bad?pool=bad",
    ])
      expect((await handleLocoRequest(new Request(`${base}/${p}`))).status).toBe(400);
    expect((await handleLocoRequest(new Request(`${base}/sendTransaction`))).status).toBe(404);
    expect((await handleLocoRequest(new Request(`${base}/pools`, { method: "POST" }))).status).toBe(
      405,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps missing metrics null and rejects wrong account programs/discriminators", () => {
    expect(
      publicPool({ address: pool, token_x: { address: pool }, token_y: { address: mint } }),
    ).toMatchObject({ tvlUsd: null, fees24hUsd: null });
    const a = {
      owner: pool,
      executable: false as const,
      data: [Buffer.alloc(16).toString("base64"), "base64"] as [string, "base64"],
    };
    expect(() => verifiedAccount(a, mint)).toThrow();
    expect(() => verifiedAccount(a, pool, Uint8Array.of(1))).toThrow();
  });
  it("bounds server work including ignored aborts", async () => {
    vi.useFakeTimers();
    const p = withLocoBudget(() => new Promise(() => {}), undefined, 100);
    const check = expect(p).rejects.toMatchObject({ code: "upstream-timeout", status: 504 });
    await vi.advanceTimersByTimeAsync(101);
    await check;
  });
  it("negotiates MCP and lists exactly five read-only tools without cloud/export/signing tools", async () => {
    const init = await rpcJson(
      await handleLocoRequest(
        rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    );
    expect(init.result.serverInfo.name).toBe("studio-loco");
    const list = await rpcJson(await handleLocoRequest(rpc("tools/list", {})));
    expect(list.result.tools).toHaveLength(5);
    expect(
      list.result.tools.every(
        (t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint,
      ),
    ).toBe(true);
    expect(list.result.tools.map((t: { name: string }) => t.name)).not.toContain(
      "loco_analyze_recorder_export",
    );
    const call = await rpcJson(
      await handleLocoRequest(
        rpc("tools/call", {
          name: "loco_plan_range",
          arguments: { lower: -10, upper: 9, active: 12 },
        }),
      ),
    );
    expect(call.result.structuredContent.options[1]).toMatchObject({ lower: 2, upper: 21 });
    const bad = await rpcJson(
      await handleLocoRequest(rpc("tools/call", { name: "sendTransaction", arguments: {} })),
    );
    expect(bad.result?.isError || bad.error).toBeTruthy();
  });
  it("rejects hostile browser Origins, oversized MCP bodies and unknown tool arguments", async () => {
    expect(
      (await handleLocoRequest(rpc("tools/list", {}, { Origin: "https://evil.example" }))).status,
    ).toBe(403);
    const large = new Request(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(17000),
    });
    expect((await handleLocoRequest(large)).status).toBe(413);
    const bad = await rpcJson(
      await handleLocoRequest(
        rpc("tools/call", { name: "loco_list_pools", arguments: { walletKey: "no" } }),
      ),
    );
    expect(bad.result?.isError || bad.error).toBeTruthy();
  });
});

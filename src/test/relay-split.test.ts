import { describe, expect, it } from "vitest";
import { splitMulti, isLargeMulti, MULTI_CHUNK } from "@/routes/api/public/rpc.$cluster";

const keys = Array.from({ length: 23 }, (_, i) => `k${i}`);
const call = { jsonrpc: "2.0", id: "x", method: "getMultipleAccounts", params: [keys, { encoding: "base64" }] };

describe("relay getMultipleAccounts split", () => {
  it("detects only >10-key calls", () => {
    expect(isLargeMulti(call)).toBe(true);
    expect(isLargeMulti({ ...call, params: [keys.slice(0, 10)] })).toBe(false);
  });
  it("chunks ≤10, preserves order and options", async () => {
    const seen: unknown[][] = [];
    const post = async (_u: string, c: { params?: unknown }) => {
      const [k, opt] = c.params as [string[], unknown];
      expect(opt).toEqual({ encoding: "base64" });
      seen.push(k);
      return { result: { context: { slot: 1 }, value: k.map((x) => ({ k: x })) } };
    };
    const r = (await splitMulti("u", call, post as never)) as { id: string; result: { value: { k: string }[] } };
    expect(seen.every((s) => s.length <= MULTI_CHUNK)).toBe(true);
    expect(r.id).toBe("x");
    expect(r.result.value.map((v) => v.k)).toEqual(keys);
  });
  it("fails the whole call when any chunk errors", async () => {
    let n = 0;
    const post = async () => (n++ === 1 ? { error: { code: -1, message: "nope" } } : { result: { context: {}, value: [] } });
    const r = (await splitMulti("u", call, post as never)) as { error?: unknown; result?: unknown };
    expect(r.error).toEqual({ code: -1, message: "nope" });
    expect(r.result).toBeUndefined();
  });
});

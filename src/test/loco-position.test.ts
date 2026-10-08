// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Buffer } from "buffer";
import { Program, type Idl, type AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { readPosition } from "../lib/loco-api.server";
const require = createRequire(import.meta.url);
vi.mock("../lib/dlmm", () => ({
  DLMM_PROGRAM_ID: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  loadSdk: async () => createRequire(import.meta.url)("@meteora-ag/dlmm"),
}));
const sdk = require("@meteora-ag/dlmm");
const programId = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const pool = "So11111111111111111111111111111111111111112";
const position = "11111111111111111111111111111111";
const mintY = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const program = new Program(
  sdk.IDL as Idl,
  { connection: new Connection("https://solana-rpc.publicnode.com") } as AnchorProvider,
);
// Build protocol-shaped fixtures through the official IDL coder, not handwritten offsets.
function initial(type: any): any {
  if (typeof type === "string") {
    if (type === "pubkey") return new PublicKey(pool);
    if (type === "bool") return false;
    if (type === "string") return "";
    if (type === "bytes") return Buffer.alloc(0);
    return /^(u|i)(64|128|256)$/.test(type) ? new BN(0) : 0;
  }
  if (type.array) return Array.from({ length: type.array[1] }, () => initial(type.array[0]));
  if (type.option) return null;
  if (type.defined)
    return initial(program.idl.types!.find((t) => t.name === type.defined.name)!.type);
  if (type.kind === "struct")
    return Object.fromEntries(type.fields.map((f: any) => [f.name, initial(f.type)]));
  if (type.kind === "enum") return { [type.variants[0].name]: {} };
  throw new Error("Unrecognized IDL fixture type");
}
async function fixture() {
  const pair = initial({ defined: { name: "lbPair" } });
  Object.assign(pair, {
    tokenXMint: new PublicKey(pool),
    tokenYMint: new PublicKey(mintY),
    activeId: 20,
    binStep: 100,
  });
  const pos = initial({ defined: { name: "positionV2" } });
  Object.assign(pos, { lbPair: new PublicKey(pool), lowerBinId: 10, upperBinId: 30 });
  const account = (data: Buffer, owner = programId) => ({
    owner,
    executable: false,
    data: [data.toString("base64"), "base64"],
  });
  const mint = (decimals: number) => {
    const bytes = Buffer.alloc(82);
    bytes[44] = decimals;
    bytes[45] = 1;
    return account(bytes, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  };
  const encode = (name: string, value: object) => {
    // Anchor's convenience encoder reserves only 1,000 bytes; PositionV2 is larger.
    const entry = (program.coder.accounts as any).accountLayouts.get(name);
    const bytes = Buffer.alloc(65536);
    const length = entry.layout.encode(value, bytes);
    return Buffer.concat([Buffer.from(entry.discriminator), bytes.subarray(0, length)]);
  };
  return {
    pair,
    pos,
    account,
    mint,
    encode: async () => [account(encode("lbPair", pair)), account(encode("positionV2", pos))],
  };
}
afterEach(() => vi.unstubAllGlobals());
it("fails before account reads if the RPC genesis is not mainnet", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: "devnet-genesis" }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(readPosition(position, pool)).rejects.toMatchObject({
    code: "verification-failed",
    status: 422,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("decodes actual IDL layouts, ties pair/position to one slot and uses a later initialized mint snapshot", async () => {
  const f = await fixture(),
    accounts = await f.encode();
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls++;
      if (body.method === "getGenesisHash")
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
        });
      if (calls === 2)
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 123 }, value: accounts },
        });
      expect(body.params[1].minContextSlot).toBe(123);
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 124 }, value: [f.mint(9), f.mint(6)] },
      });
    }),
  );
  const r = await readPosition(position, pool);
  expect(r).toMatchObject({
    data: {
      lowerBinId: 10,
      upperBinId: 30,
      activeBinId: 20,
      inRange: true,
      binStep: 100,
      decimalsX: 9,
      decimalsY: 6,
    },
    meta: { source: "solana-confirmed", slot: 123, mintSlot: 124 },
  });
});
it("rejects a valid PositionV2 belonging to a different pool", async () => {
  const f = await fixture();
  f.pos.lbPair = new PublicKey(mintY);
  const accounts = await f.encode();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_: string, init: RequestInit) =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        result:
          JSON.parse(init.body as string).method === "getGenesisHash"
            ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
            : { context: { slot: 123 }, value: accounts },
      }),
    ),
  );
  await expect(readPosition(position, pool)).rejects.toMatchObject({
    code: "verification-failed",
    status: 422,
  });
});

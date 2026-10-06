import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

describe("published Anchor compatibility", () => {
  it("uses a browser entry without the Node-only CommonJS workspace branch", async () => {
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@meteora-ag/dlmm"));
    for (const resolver of [require, sdkRequire]) {
      const entry = join(dirname(resolver.resolve("@coral-xyz/anchor/package.json")), "dist/browser/index.js");
      const source = readFileSync(entry, "utf8");
      expect(source).not.toContain("exports.workspace");
      expect(source).not.toContain("exports.Wallet");
      const anchor = await import(/* @vite-ignore */ entry);
      expect(typeof anchor.Program).toBe("function");
      expect(typeof anchor.AnchorProvider).toBe("function");
    }
  });
});
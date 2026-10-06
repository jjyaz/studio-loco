// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Anchor's advertised ESM entry still references CommonJS `exports` outside a browser.
// Resolve each installed version's real browser entry, preserving the SDK's own version.
const anchorBrowserEntry = {
  name: "studio-loco:anchor-browser-entry",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (source !== "@coral-xyz/anchor" && source !== "@coral-xyz/anchor/dist/cjs/utils/bytes") return;
    const require = createRequire(importer?.split("?")[0] ?? import.meta.url);
    const packagePath = require.resolve("@coral-xyz/anchor/package.json");
    return join(dirname(packagePath), source === "@coral-xyz/anchor"
      ? "dist/browser/index.js"
      : "dist/esm/utils/bytes/index.js");
  },
};

// Some Solana deps export only "browser"/"node" conditions (no "default"), which the Worker
// build can't resolve. Let server environments fall back to their browser (fetch-based) builds.
const workerBrowserFallback = {
  name: "studio-loco:worker-browser-condition",
  configEnvironment(name: string, config: { resolve?: { conditions?: string[] } }) {
    if (name === "client") return;
    const c = config.resolve?.conditions;
    if (c && !c.includes("browser")) return { resolve: { conditions: [...c, "browser"] } };
    return undefined;
  },
};

// The mobile wallet adapter crashes the Worker at import time (util.inherits on undefined).
// Server builds get a stub; the browser keeps the real package.
const mobileWalletServerStub = {
  name: "studio-loco:mobile-wallet-server-stub",
  enforce: "pre" as const,
  resolveId(this: { environment?: { name: string } }, source: string) {
    if (source !== "@solana-mobile/wallet-adapter-mobile") return;
    if (this.environment?.name === "client") return;
    return join(process.cwd(), "src/lib/mobile-wallet-ssr-stub.ts");
  },
};

// bn.js maps "buffer" to false in its package "browser" field. In the production client build
// Rolldown applied that empty stub to every `buffer` import, so safe-buffer/bs58/web3.js crashed
// with "Cannot read properties of undefined (reading 'from')" and the page never hydrated.
// Drop bn.js's optional require (it already falls back without Buffer) so the stub never exists.
const bnBufferStubFix = {
  name: "studio-loco:bn-buffer-stub-fix",
  enforce: "pre" as const,
  transform(this: { environment?: { name: string } }, code: string, id: string) {
    if (this.environment?.name !== "client") return;
    if (!/[\\/]bn\.js[\\/]lib[\\/]bn\.js$/.test(id.split("?")[0])) return;
    const next = code.replace("require('buffer').Buffer", "undefined");
    return next === code ? undefined : { code: next, map: null };
  },
};

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [workerBrowserFallback, anchorBrowserEntry, mobileWalletServerStub, bnBufferStubFix],
    // Resolve these before the final server bundling stage; never externalize them.
    ssr: { noExternal: [/^@solana\/wallet-adapter-react$/, /^@meteora-ag\/dlmm$/, /^@coral-xyz\/anchor$/] },
  },
});

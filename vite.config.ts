// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Some Solana deps only export "browser"/"node" conditions (no "default"), which the Worker
// build can't resolve. Point them at their browser (fetch/WebSocket-standard) builds.
const nm = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url));

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    resolve: {
      alias: [
        { find: /^rpc-websockets$/, replacement: nm("rpc-websockets/dist/index.browser.mjs") },
        { find: /^@solana\/codecs$/, replacement: nm("@solana/codecs/dist/index.browser.mjs") },
      ],
    },
  },
});

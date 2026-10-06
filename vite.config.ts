// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Some Solana deps export only "browser"/"node" conditions (no "default"), which the Worker
// build can't resolve. Let server environments fall back to their browser (fetch-based) builds.
const workerBrowserFallback = {
  name: "studio-loco:worker-browser-condition",
  configEnvironment(name: string, config: { resolve?: { conditions?: string[] } }) {
    if (name === "client") return;
    const c = config.resolve?.conditions;
    if (c && !c.includes("browser")) return { resolve: { conditions: [...c, "browser"] } };
  },
};

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: { plugins: [workerBrowserFallback] },
});

import { defineConfig } from "vitest/config";
import path from "node:path";

// Explicitly invoked network acceptance tests. Never run as part of the unit suite.
export default defineConfig({
  test: { environment: "node", include: ["scripts/qa/*.acceptance.ts"], testTimeout: 600_000, hookTimeout: 30_000, fileParallelism: false },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../src") } },
});

import { Buffer } from "buffer";

/**
 * Solana / Anchor libraries expect Buffer, `global` and `process` as globals in the browser.
 * Must be CALLED (not just imported): package.json declares "sideEffects": false, so the
 * production bundler drops side-effect-only imports and the globals never get installed.
 */
export function installNodeGlobals(): void {
  const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: { env: Record<string, string> } };
  if (!g.Buffer) g.Buffer = Buffer;
  if (!g.global) g.global = globalThis;
  if (!g.process) g.process = { env: {} };
}

installNodeGlobals();

import { Buffer } from "buffer";

// Solana / Anchor libraries expect Buffer and `global` in the browser.
const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: { env: Record<string, string> } };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) g.process = { env: {} };

export {};

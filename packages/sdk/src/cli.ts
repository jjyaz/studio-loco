#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LocoClient } from "./client.js";
import { createLocoMcpServer } from "./mcp.js";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stderr.write(
    "Usage: loco-mcp [--base-url https://host/api/public/loco/v1] [--local-evidence]\nRead-only stdio MCP. Evidence analysis is opt-in and runs in memory locally.\n",
  );
} else {
  try {
    let baseUrl: string | undefined,
      localEvidence = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--local-evidence") localEvidence = true;
      else if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i];
      else throw new Error("Unknown or incomplete argument; use --help");
    }
    const client = new LocoClient({ baseUrl });
    serveStdio(() => createLocoMcpServer(client, { localEvidence }));
  } catch {
    process.stderr.write("Unable to start Loco MCP. Check arguments with --help.\n");
    process.exitCode = 1;
  }
}

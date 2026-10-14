// Run with a user-exported Conductor journal: node mission.mjs ./mission-evidence.json
// File access belongs to this caller; the SDK/MCP analyzer does not read files or upload evidence.
import { readFile } from "node:fs/promises";
import { analyzeMissionExport } from "@studio-loco/sdk";
if (!process.argv[2]) throw new Error("Pass the path to your exported Conductor evidence JSON.");
console.log(await analyzeMissionExport(await readFile(process.argv[2], "utf8")));

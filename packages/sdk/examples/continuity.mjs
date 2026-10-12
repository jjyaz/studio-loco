import { readFile } from "node:fs/promises";
import { analyzeContinuityExport } from "@studio-loco/sdk";
if (!process.argv[2]) throw new Error("Provide a locally exported Studio Loco continuity JSON file");
console.log(analyzeContinuityExport(await readFile(process.argv[2], "utf8")));

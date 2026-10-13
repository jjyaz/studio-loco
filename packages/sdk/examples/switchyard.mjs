// Local file supplied explicitly by the user. The SDK never accesses device history.
import { readFile } from "node:fs/promises";
import { analyzeSwitchyardExport } from "@studio-loco/sdk";
if (!process.argv[2]) throw new Error("Usage: node switchyard.mjs <exported-switchyard.json>");
const supplied = JSON.parse(await readFile(process.argv[2], "utf8"));
console.log(JSON.stringify(analyzeSwitchyardExport(supplied), null, 2));

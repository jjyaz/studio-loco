import { readFile } from "node:fs/promises";
import { inspectBlueprint, protocolAdapters } from "@studio-loco/sdk";

// Explicit caller-selected configuration file. Never a signer or executable transaction.
const path = process.argv[2];
if (!path) throw new Error("Pass the path to an exported Studio Loco blueprint JSON file.");
const inspection = await inspectBlueprint(JSON.parse(await readFile(path, "utf8")));
console.log(
  JSON.stringify(
    {
      digest: inspection.digest,
      readOnly: inspection.readOnly,
      executable: inspection.executable,
      blueprint: inspection.blueprint,
      adapters: protocolAdapters(),
    },
    null,
    2,
  ),
);

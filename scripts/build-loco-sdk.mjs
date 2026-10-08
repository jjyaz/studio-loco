import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "loco-sdk-release-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
      cwd: join(root, "packages/sdk"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  )[0];
  const bytes = readFileSync(join(temp, packed.filename));
  const version = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8")).version;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // UTF-8 manifest allows the connected GitHub/Lovable build to serve the exact reviewed tarball.
  writeFileSync(
    join(root, "src/lib/loco-sdk-release.json"),
    JSON.stringify({ version, sha256, bytes: bytes.length, base64: bytes.toString("base64") }) +
      "\n",
  );
  const output = join(root, ".qa/sdk-release");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `studio-loco-sdk-${version}.tgz`), bytes);
  console.log(`SDK ${version}: ${bytes.length} bytes; SHA-256 ${sha256}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

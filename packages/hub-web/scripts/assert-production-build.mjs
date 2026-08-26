import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(packageRoot, "../../dist/hub");
const manifestPath = join(outputRoot, ".vite", "manifest.json");
const manifest = readFileSync(manifestPath, "utf8");

if (/fixture-api|src\/dev\//i.test(manifest)) {
  throw new Error("The production Hub manifest contains a development fixture module.");
}

const forbiddenFixtureData = [
  "job_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Three knowledge pages lost grounding",
  "scf_mex",
  "event_01K36WVM6H7JK8M9NPQRSTVVWX",
  "Keep activity immutable and preserve legacy history",
];

for (const file of filesUnder(outputRoot)) {
  const bytes = readFileSync(file);
  for (const sentinel of forbiddenFixtureData) {
    if (bytes.includes(Buffer.from(sentinel))) {
      throw new Error(`The production Hub asset ${file} contains development fixture data.`);
    }
  }
}

function* filesUnder(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

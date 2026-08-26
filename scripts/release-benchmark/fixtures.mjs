import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FIXED_GIT_DATE = "2026-08-01T00:00:00Z";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export const RELEASE_FIXTURE_PROFILES = Object.freeze({
  small: Object.freeze({ sourceFiles: 4, wikiEntities: 4, activityEvents: 4 }),
  medium: Object.freeze({ sourceFiles: 16, wikiEntities: 16, activityEvents: 16 }),
  large: Object.freeze({ sourceFiles: 48, wikiEntities: 48, activityEvents: 48 }),
});

export function createReleaseFixture({
  destination,
  profileName,
  cliPath,
  environment,
}) {
  const profile = RELEASE_FIXTURE_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown release benchmark profile: ${profileName}`);
  if (existsSync(destination)) throw new Error(`Fixture destination already exists: ${destination}`);

  const root = resolve(destination);
  const scaffold = join(root, ".mex");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(scaffold, "context"), { recursive: true });
  mkdirSync(join(scaffold, "events", "activity", "2026-08"), { recursive: true });

  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: `mex-release-benchmark-${profileName}`,
    private: true,
    type: "module",
  }, null, 2)}\n`);
  writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  writeFileSync(join(root, ".gitignore"), [
    ".mex/graph.db*",
    ".mex/wiki.db*",
    ".mex/local/",
    "node_modules/",
    "",
  ].join("\n"));
  writeFileSync(join(scaffold, "ROUTER.md"), [
    "# Release benchmark fixture",
    "",
    "Deterministic local input for the MEX release resource benchmark.",
    "",
  ].join("\n"));
  writeFileSync(join(scaffold, "config.json"), `${JSON.stringify({
    scaffold_id: fixtureUuid(profileName),
    scaffold_name: `release-benchmark-${profileName}`,
    aiTools: [],
    wiki: {
      exclude: ["**/node_modules/**", "events/**"],
      readOnly: ["team/**", "workstreams/**", "inbox/**", "relays/**"],
    },
  }, null, 2)}\n`);

  for (let index = 0; index < profile.sourceFiles; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const previous = String(Math.max(0, index - 1)).padStart(4, "0");
    writeFileSync(join(root, "src", `module-${suffix}.ts`), sourceModule(index, suffix, previous));
  }

  const wikiIds = Array.from({ length: profile.wikiEntities }, (_, index) => fixedId("mx_", index + 1));
  for (let index = 0; index < wikiIds.length; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const nextId = wikiIds[(index + 1) % wikiIds.length];
    writeFileSync(
      join(scaffold, "context", `benchmark-${suffix}.md`),
      wikiDocument({ id: wikiIds[index], nextId, index, mutable: index === 0 }),
    );
  }

  for (let index = 0; index < profile.activityEvents; index += 1) {
    const id = fixedId("event_", 10_000 + index);
    const timestamp = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
    writeFileSync(
      join(scaffold, "events", "activity", "2026-08", `${id}.md`),
      activityDocument({ id, index, timestamp }),
    );
  }

  initializeReleaseFixtureGit(root, environment);

  run(process.execPath, [cliPath, "graph", "rebuild", "--root", root, "--json"], root, environment, 180_000);
  run(process.execPath, [cliPath, "wiki", "rebuild-index", "--json"], root, environment, 180_000);

  const input = fixtureInputSizes(root);
  return {
    profileName,
    root,
    profile,
    firstWikiEntityId: wikiIds[0],
    mutableWikiPath: ".mex/context/benchmark-0000.md",
    input,
  };
}

export function initializeReleaseFixtureGit(root, environment) {
  run("git", ["init", "--quiet", "--initial-branch=benchmark", "--object-format=sha1"], root, environment);
  run("git", ["config", "user.name", "MEX Release Benchmark"], root, environment);
  run("git", ["config", "user.email", "release-benchmark@example.invalid"], root, environment);
  run("git", ["add", "--", ".gitignore", "package.json", "tsconfig.json", ".mex", "src"], root, environment);
  run("git", ["commit", "--quiet", "--no-gpg-sign", "--message", "release benchmark fixture"], root, {
    ...environment,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_AUTHOR_EMAIL: "release-benchmark@example.invalid",
    GIT_AUTHOR_NAME: "MEX Release Benchmark",
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_EMAIL: "release-benchmark@example.invalid",
    GIT_COMMITTER_NAME: "MEX Release Benchmark",
  });
  return run("git", ["rev-parse", "HEAD"], root, environment).trim();
}

export function copyReleaseFixture(source, destination) {
  if (existsSync(destination)) throw new Error(`Fixture copy destination already exists: ${destination}`);
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  return resolve(destination);
}

export function toggleWikiRefreshMarker(root, relativePath) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const from = before.includes("benchmark-state:A") ? "benchmark-state:A" : "benchmark-state:B";
  const to = from.endsWith("A") ? "benchmark-state:B" : "benchmark-state:A";
  const after = before.replace(from, to);
  if (after === before || Buffer.byteLength(after) !== Buffer.byteLength(before)) {
    throw new Error("The Wiki refresh marker could not be toggled byte-for-byte.");
  }
  writeFileSync(path, after, "utf8");
}

export function toggleSourceRefreshMarker(root, relativePath = "src/module-0000.ts") {
  toggleMarker(join(root, relativePath), "source");
}

export function fixtureInputSizes(root) {
  const graphPaths = graphInputFiles(root);
  const wikiPaths = filesUnder(join(root, ".mex"))
    .filter((path) => /\.mdx?$/iu.test(path))
    .filter((path) => !toPosix(relative(join(root, ".mex"), path)).startsWith("events/"));
  return {
    graphBytes: totalBytes(graphPaths),
    graphFiles: graphPaths.length,
    wikiBytes: totalBytes(wikiPaths),
    wikiFiles: wikiPaths.length,
  };
}

function graphInputFiles(root) {
  const ignoredDirectories = new Set([
    ".git",
    ".mex",
    ".next",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
  ]);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !ignoredDirectories.has(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (/\.(?:[cm]?[jt]sx?|py|rs)$/u.test(entry.name)
        || entry.name === "package.json"
        || /^(?:ts|js)config[^/]*\.json$/u.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function sqliteFamilySize(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(existsSync)
    .reduce((total, path) => total + statSync(path).size, 0);
}

function sourceModule(index, suffix, previous) {
  const dependency = index === 0
    ? ""
    : `import { releaseBenchmarkNeedle${previous} } from \"./module-${previous}.js\";\n\n`;
  const upstream = index === 0 ? "input + 17" : `releaseBenchmarkNeedle${previous}(input)`;
  return `${dependency}`
    + (index === 0 ? "// benchmark-source-state:A\n" : "")
    + `export interface BenchmarkPayload${suffix} {\n`
    + "  readonly id: number;\n"
    + "  readonly label: string;\n"
    + "  readonly values: readonly number[];\n"
    + "}\n\n"
    + `export function releaseBenchmarkNeedle${suffix}(input: number): number {\n`
    + `  const upstream = ${upstream};\n`
    + `  const payload: BenchmarkPayload${suffix} = { id: ${index}, label: \"release-benchmark-${suffix}\", values: [upstream, upstream + 1] };\n`
    + "  return payload.values.reduce((total, value) => total + value, payload.id);\n"
    + "}\n\n"
    + `export const benchmarkDescriptor${suffix} = Object.freeze({ key: \"release-benchmark-needle\", run: releaseBenchmarkNeedle${suffix} });\n`;
}

function toggleMarker(path, label) {
  const before = readFileSync(path, "utf8");
  const stateA = `benchmark-${label}-state:A`;
  const stateB = `benchmark-${label}-state:B`;
  const from = before.includes(stateA) ? stateA : stateB;
  const to = from.endsWith("A") ? stateB : stateA;
  const after = before.replace(from, to);
  if (after === before || Buffer.byteLength(after) !== Buffer.byteLength(before)) {
    throw new Error(`The ${label} refresh marker could not be toggled byte-for-byte.`);
  }
  writeFileSync(path, after, "utf8");
}

function wikiDocument({ id, nextId, index, mutable }) {
  const suffix = String(index).padStart(4, "0");
  return [
    "<!-- mex:entity",
    `id: ${id}`,
    `type: ${index % 2 === 0 ? "decision" : "pattern"}`,
    "status: promoted",
    "revision: 1",
    `summary: Release benchmark knowledge needle ${suffix}.`,
    "relations:",
    "  - type: related_to",
    `    target: ${nextId}`,
    "sources:",
    "  - type: manual",
    "    note: Deterministic release benchmark evidence.",
    "-->",
    `## Release benchmark knowledge ${suffix}`,
    "",
    `This fixed Knowledge record contains the release benchmark search needle ${suffix}.`,
    ...(mutable ? ["", "<!-- benchmark-state:A -->"] : []),
    "",
  ].join("\n");
}

function activityDocument({ id, index, timestamp }) {
  const suffix = String(index).padStart(4, "0");
  return [
    "---",
    "schema_version: 1",
    `id: ${JSON.stringify(id)}`,
    `timestamp: ${JSON.stringify(timestamp)}`,
    "actor: {\"email\":\"release-benchmark@example.invalid\",\"kind\":\"git\",\"name\":\"MEX Release Benchmark\"}",
    `action: ${JSON.stringify(`benchmark.read.${suffix}`)}`,
    `subjects: [{\"kind\":\"file\",\"path\":\"src/module-${suffix}.ts\"}]`,
    "repo_state: {\"branch\":\"benchmark\",\"dirty\":false,\"head\":null,\"observedAt\":\"2026-08-01T00:00:00.000Z\"}",
    "metadata: {}",
    "---",
    "",
  ].join("\n");
}

function fixedId(prefix, value) {
  let remaining = (1n << 120n) + BigInt(value);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return `${prefix}${encoded}`;
}

function fixtureUuid(profileName) {
  const suffix = String(Object.keys(RELEASE_FIXTURE_PROFILES).indexOf(profileName) + 1);
  return `22222222-2222-4222-8222-22222222222${suffix}`;
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function totalBytes(paths) {
  return paths.reduce((total, path) => total + statSync(path).size, 0);
}

function run(command, args, cwd, environment, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    killSignal: "SIGKILL",
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    shell: false,
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed with status ${String(result.status)}: ${bounded(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

function toPosix(path) {
  return path.replaceAll("\\", "/");
}

import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { runSync } from "./process.mjs";
import { expandToken } from "./suite.mjs";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function fileHash(path) { return sha256(readFileSync(path)); }

function git(root, args, optional = false) {
  const result = runSync("git", args, { cwd: root });
  if (result.code !== 0 && !optional) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.code === 0 ? result.stdout.trim() : null;
}

export function repositoryIdentity(root) {
  const status = git(root, ["status", "--porcelain"], true) ?? "";
  const dirtyEntries = status.split("\n").filter(Boolean).filter((line) => !/^\?\? \.mex(?:\/|$)/.test(line));
  return {
    root: resolve(root),
    sha: git(root, ["rev-parse", "HEAD"]),
    remote: git(root, ["remote", "get-url", "origin"], true),
    dirty: dirtyEntries.length > 0,
    dirtyEntries,
  };
}

function worktreeDiffHash(root) {
  const tracked = git(root, ["diff", "--binary", "HEAD"], true) ?? "";
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard"], true) ?? "").split("\n").filter(Boolean).sort();
  const hash = createHash("sha256").update(tracked);
  for (const path of untracked) {
    hash.update(`\0${path}\0`);
    const absolute = join(root, path);
    if (existsSync(absolute)) hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

function findSymbol(root, symbol) {
  const result = runSync("rg", ["--line-number", "--column", "--no-heading", "--color", "never", "--fixed-strings", "--glob", "!.git/**", "--glob", "!.mex/**", symbol, "."], { cwd: root });
  if (![0, 1].includes(result.code)) throw new Error(`rg failed while locating ${symbol}: ${result.stderr.trim()}`);
  const rows = result.stdout.split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) return null;
    const [, path, lineNumber, column, text] = match;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const definition = new RegExp(`(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|sub|proc)\\s+${escaped}\\b|${escaped}\\s*[:=]`).test(text);
    return { path: path.replace(/^\.\//, ""), line: Number(lineNumber), column: Number(column), text: text.trim(), definition };
  }).filter(Boolean);
  if (!rows.length) throw new Error(`expected symbol not found in subject repository: ${symbol}`);
  rows.sort((a, b) => Number(b.definition) - Number(a.definition) || a.path.localeCompare(b.path) || a.line - b.line);
  return rows[0];
}

export function collectGoldEvidence(root, tasks) {
  return tasks.map((task) => ({
    taskId: task.id,
    symbols: task.expectedSymbols.map((symbol) => ({ symbol, ...findSymbol(root, symbol) })),
  }));
}

export function validateSubjectFixture(suite, subjectRoot) {
  const subject = repositoryIdentity(subjectRoot);
  if (suite.subject.revision && subject.sha !== suite.subject.revision) {
    throw new Error(`subject SHA mismatch: expected ${suite.subject.revision}, found ${subject.sha}`);
  }
  if (suite.subject.revision && subject.dirty) {
    throw new Error(`subject checkout has changes outside .mex and is not an exact pinned fixture: ${subject.dirtyEntries.join(", ")}`);
  }
  return { subject, goldEvidence: collectGoldEvidence(subjectRoot, suite.tasks) };
}

/** Build configured control CLIs from local git objects. This uses git archive, never clone. */
export function buildConfiguredArmArtifacts({ suite, context, outputDir, overrides }) {
  const generated = { ...overrides };
  const artifactsDir = join(outputDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [armId, arm] of Object.entries(suite.arms)) {
    if (arm.kind !== "graph" || generated[armId] || arm.cli || !arm.buildFromGit) continue;
    const build = arm.buildFromGit;
    const sourceRoot = resolve(expandToken(build.root, context));
    const artifactRoot = join(artifactsDir, armId);
    const cliPath = join(artifactRoot, build.cli);
    if (existsSync(cliPath)) { generated[armId] = cliPath; continue; }
    if (existsSync(artifactRoot)) throw new Error(`incomplete arm artifact exists at ${artifactRoot}; move it aside and retry`);
    const tempRoot = mkdtempSync(join(artifactsDir, `.${armId}-`));
    try {
      const archivePath = join(tempRoot, "source.tar");
      const archive = runSync("git", ["archive", "--format=tar", build.revision], { cwd: sourceRoot, encoding: null, maxBuffer: 256 * 1024 * 1024 });
      if (archive.code !== 0) throw new Error(`cannot archive ${armId} at ${build.revision}: ${String(archive.stderr).trim()}`);
      writeFileSync(archivePath, archive.stdout);
      const extract = runSync("tar", ["-xf", archivePath, "-C", tempRoot], { cwd: sourceRoot });
      if (extract.code !== 0) throw new Error(`cannot extract ${armId}: ${extract.stderr.trim()}`);
      rmSync(archivePath, { force: true });
      const sharedModules = join(sourceRoot, "node_modules");
      if (build.shareNodeModules && existsSync(sharedModules)) symlinkSync(sharedModules, join(tempRoot, "node_modules"), "dir");
      for (const command of build.commands) {
        const [executable, ...args] = command.map((token) => expandToken(token, { ...context, armRoot: tempRoot }));
        const result = runSync(executable, args, { cwd: tempRoot });
        if (result.code !== 0) throw new Error(`${armId} build failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      if (!existsSync(join(tempRoot, build.cli))) throw new Error(`${armId} build did not produce ${build.cli}`);
      renameSync(tempRoot, artifactRoot);
      generated[armId] = cliPath;
    } catch (error) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return generated;
}

function cloneCopy(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_FICLONE);
}

export class GraphDbGuard {
  constructor(subjectRoot, scratchRoot) {
    this.db = join(subjectRoot, ".mex", "graph.db");
    this.sidecars = [this.db, `${this.db}-wal`, `${this.db}-shm`];
    this.backups = this.sidecars.map((path) => join(scratchRoot, "original", relative(subjectRoot, path)));
    this.present = this.sidecars.map(existsSync);
    this.present.forEach((present, index) => { if (present) cloneCopy(this.sidecars[index], this.backups[index]); });
  }
  clear() { for (const path of this.sidecars) rmSync(path, { force: true }); }
  activate(snapshot) { this.clear(); cloneCopy(snapshot, this.db); }
  restore() {
    this.clear();
    this.present.forEach((present, index) => { if (present) cloneCopy(this.backups[index], this.sidecars[index]); });
  }
}

export function buildArmIndices({ suite, subjectRoot, armCommands, outputDir }) {
  const indexDir = join(outputDir, "indices");
  const scratch = join(outputDir, ".prepare-scratch");
  mkdirSync(indexDir, { recursive: true });
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const indices = {};
  try {
    for (const [armId, arm] of Object.entries(suite.arms)) {
      if (arm.kind !== "graph") continue;
      guard.clear();
      const [command, ...prefix] = armCommands[armId];
      const result = runSync(command, [...prefix, "graph", "--json"], { cwd: subjectRoot });
      if (result.code !== 0) throw new Error(`indexing failed for ${armId}: ${result.stderr.trim() || result.stdout.trim()}`);
      if (!existsSync(guard.db)) throw new Error(`${armId} did not create ${guard.db}`);
      const snapshot = join(indexDir, `${armId}.graph.db`);
      cloneCopy(guard.db, snapshot);
      indices[armId] = { path: snapshot, sha256: fileHash(snapshot), buildOutput: result.stdout.trim() };
    }
  } finally {
    guard.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
  return indices;
}

export function prepareEvaluation({ suite, subjectRoot, harnessRoot, armCommands, outputDir, index = true, subjectFixture }) {
  mkdirSync(outputDir, { recursive: true });
  const { subject, goldEvidence } = subjectFixture ?? validateSubjectFixture(suite, subjectRoot);
  const harness = repositoryIdentity(harnessRoot);
  const cli = Object.fromEntries(Object.entries(armCommands).map(([armId, command]) => {
    const script = command[0] === process.execPath ? command[1] : command[0];
    return [armId, { command, sha256: existsSync(script) ? fileHash(script) : null, declaredRevision: suite.arms[armId].revision ?? null }];
  }));
  const indices = index ? buildArmIndices({ suite, subjectRoot, armCommands, outputDir }) : {};
  const manifest = {
    schemaVersion: 1, suiteId: suite.id, preparedAt: new Date().toISOString(),
    subject, harness: { ...harness, diffSha256: worktreeDiffHash(harnessRoot) }, cli, indices, goldEvidence,
  };
  writeFileSync(join(outputDir, "prepare.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

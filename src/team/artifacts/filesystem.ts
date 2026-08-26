import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  isRepoRelativePath,
  type RepoRelativePath,
  type Revision,
} from "../contracts/shared.js";
import { artifactError } from "./errors.js";
import { revisionOf } from "./revision.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ContainedArtifactRead {
  bytes: Uint8Array;
  revision: Revision;
  canonicalPath: string;
}

/** Resolve a caller-supplied root once so repositories cannot follow a later symlink swap. */
export function canonicalizeProjectRoot(projectRoot: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(projectRoot);
  } catch {
    throw artifactError("NOT_FOUND", "Repository not found", "The project root does not exist.");
  }
  if (!statSync(canonicalRoot).isDirectory()) {
    throw artifactError("PATH_OUTSIDE_PROJECT", "Unsafe project root", "The project root is not a directory.");
  }
  return canonicalRoot;
}

/** Read one regular artifact without following its final path through a symlink. */
export function readContainedArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  maxBytes: number,
): ContainedArtifactRead {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  let descriptor: number | undefined;
  try {
    assertSafeExistingComponents(canonicalRoot, path, true);
    descriptor = openSync(lexicalPath, constants.O_RDONLY | NO_FOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw unsafePath(path, "Artifact is not a regular file.");
    if (before.size > maxBytes) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Artifact is too large",
        `Artifact exceeds ${maxBytes} bytes.`,
        path,
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameIdentity(before, after) || before.size !== after.size || bytes.byteLength !== after.size) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact changed during read",
        "The artifact changed while it was being read. Retry the operation.",
        path,
      );
    }

    const pathStat = lstatSync(lexicalPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameIdentity(after, pathStat)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact path changed during read",
        "The artifact path changed while it was being read. Retry the operation.",
        path,
      );
    }
    const canonicalPath = realpathSync(lexicalPath);
    assertContained(canonicalRoot, canonicalPath, path);
    const canonicalStat = statSync(canonicalPath);
    if (!sameIdentity(after, canonicalStat)) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact path changed during read",
        "The artifact target changed while it was being read. Retry the operation.",
        path,
      );
    }
    return { bytes, revision: revisionOf(bytes), canonicalPath };
  } catch (error) {
    if (isNotFound(error)) {
      throw artifactError("NOT_FOUND", "Artifact not found", `Artifact ${path} does not exist.`, path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function tryReadContainedArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  maxBytes: number,
): ContainedArtifactRead | null {
  try {
    return readContainedArtifact(projectRoot, path, maxBytes);
  } catch (error) {
    if (isMexCode(error, "NOT_FOUND")) return null;
    throw error;
  }
}

/** Publish a fully-written file without ever replacing an existing target. */
export function atomicCreateArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  bytes: string | Uint8Array,
): Revision {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  const parentPath = ensureSafeDirectory(canonicalRoot, dirname(path) as RepoRelativePath);
  assertTargetAbsentOrRegular(lexicalPath, path, true);
  const payload = asBytes(bytes);
  const temporaryPath = stageFile(parentPath, basename(path), payload);

  try {
    assertSafeExistingComponents(canonicalRoot, dirname(path) as RepoRelativePath, false);
    try {
      linkSync(temporaryPath, lexicalPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Artifact already exists",
          `Artifact ${path} already exists.`,
          path,
        );
      }
      throw error;
    }
    unlinkIfPresent(temporaryPath);
    fsyncDirectory(parentPath);
    return revisionOf(payload);
  } finally {
    unlinkIfPresent(temporaryPath);
  }
}

/** Atomically replace a regular artifact after an exact-byte optimistic check. */
export function atomicReplaceArtifact(
  projectRoot: string,
  path: RepoRelativePath,
  expectedRevision: Revision,
  bytes: string | Uint8Array,
): Revision {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  const parentRelative = dirname(path) as RepoRelativePath;
  const parentPath = ensureSafeDirectory(canonicalRoot, parentRelative);
  const lockPath = resolve(parentPath, `.${basename(path)}.mex-lock`);
  let lockDescriptor: number | undefined;
  let lockOwned = false;
  let lockIdentity: FileIdentity | undefined;
  let temporaryPath: string | undefined;

  try {
    try {
      lockDescriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      lockOwned = true;
      lockIdentity = identityOf(fstatSync(lockDescriptor));
      writeFileSync(lockDescriptor, `${process.pid}\n`, "utf8");
      fsyncSync(lockDescriptor);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Artifact is being updated",
          `Artifact ${path} is already locked by another writer.`,
          path,
        );
      }
      throw error;
    }

    assertExpectedRevision(projectRoot, path, expectedRevision);
    const payload = asBytes(bytes);
    temporaryPath = stageFile(parentPath, basename(path), payload);

    // Revalidate after all potentially expensive serialization/staging work.
    assertSafeExistingComponents(canonicalRoot, parentRelative, false);
    assertExpectedRevision(projectRoot, path, expectedRevision);
    assertTargetAbsentOrRegular(lexicalPath, path, false);
    renameSync(temporaryPath, lexicalPath);
    temporaryPath = undefined;
    fsyncDirectory(parentPath);
    return revisionOf(payload);
  } finally {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (temporaryPath !== undefined) unlinkIfPresent(temporaryPath);
    if (lockOwned && lockIdentity !== undefined) unlinkOwnedLock(lockPath, lockIdentity);
  }
}

export function assertContainedArtifactDirectory(
  projectRoot: string,
  path: RepoRelativePath,
): string | null {
  const { canonicalRoot, lexicalPath } = resolveArtifactPath(projectRoot, path);
  let current = canonicalRoot;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segment} is not a regular directory.`);
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
  return lexicalPath;
}

/** Serialize cooperating multi-file invariants such as member-alias uniqueness. */
export async function withContainedArtifactLock<T>(
  projectRoot: string,
  directory: RepoRelativePath,
  lockName: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(lockName)) {
    throw artifactError("VALIDATION_FAILED", "Invalid artifact lock", "Artifact lock name is invalid.");
  }
  const { canonicalRoot } = resolveArtifactPath(projectRoot, directory);
  const directoryPath = ensureSafeDirectory(canonicalRoot, directory);
  const lockPath = resolve(directoryPath, lockName);
  let descriptor: number | undefined;
  let owned = false;
  let lockIdentity: FileIdentity | undefined;
  try {
    try {
      descriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      owned = true;
      lockIdentity = identityOf(fstatSync(descriptor));
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Artifact collection is being updated",
          `Artifact lock ${lockName} is already held by another writer.`,
          directory,
        );
      }
      throw error;
    }
    assertSafeExistingComponents(canonicalRoot, directory, false);
    return await operation();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned && lockIdentity !== undefined) unlinkOwnedLock(lockPath, lockIdentity);
  }
}

function assertExpectedRevision(
  projectRoot: string,
  path: RepoRelativePath,
  expectedRevision: Revision,
): void {
  let current: ContainedArtifactRead;
  try {
    current = readContainedArtifact(projectRoot, path, 64 * 1024 * 1024);
  } catch (error) {
    if (isMexCode(error, "NOT_FOUND")) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact revision conflict",
        `Artifact ${path} disappeared before the write could be applied.`,
        path,
      );
    }
    throw error;
  }
  if (current.revision !== expectedRevision) {
    throw artifactError(
      "REVISION_CONFLICT",
      "Artifact revision conflict",
      `Artifact ${path} no longer matches the expected revision.`,
      path,
    );
  }
}

function stageFile(parentPath: string, targetName: string, bytes: Uint8Array): string {
  const temporaryPath = resolve(
    parentPath,
    `.${targetName}.mex-tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o644,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    return temporaryPath;
  } catch (error) {
    unlinkIfPresent(temporaryPath);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureSafeDirectory(canonicalRoot: string, path: RepoRelativePath): string {
  assertValidPath(path);
  let current = canonicalRoot;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    try {
      mkdirSync(current, { mode: 0o755 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segment} is not a regular directory.`);
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
  return current;
}

function assertSafeExistingComponents(
  canonicalRoot: string,
  path: RepoRelativePath,
  finalMustBeFile: boolean,
): void {
  assertValidPath(path);
  let current = canonicalRoot;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw unsafePath(path, `Path component ${segments[index]} must not be a symbolic link.`);
    }
    const final = index === segments.length - 1;
    if ((!final || !finalMustBeFile) && !stat.isDirectory()) {
      throw unsafePath(path, `Path component ${segments[index]} is not a directory.`);
    }
    if (final && finalMustBeFile && !stat.isFile()) {
      throw unsafePath(path, "Artifact is not a regular file.");
    }
    assertContained(canonicalRoot, realpathSync(current), path);
  }
}

function assertTargetAbsentOrRegular(
  target: string,
  path: RepoRelativePath,
  mustBeAbsent: boolean,
): void {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw unsafePath(path, "Artifact target is not a regular file.");
    }
    if (mustBeAbsent) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Artifact already exists",
        `Artifact ${path} already exists.`,
        path,
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      if (!mustBeAbsent) {
        throw artifactError("NOT_FOUND", "Artifact not found", `Artifact ${path} does not exist.`, path);
      }
      return;
    }
    throw error;
  }
}

function resolveArtifactPath(
  projectRoot: string,
  path: RepoRelativePath,
): { canonicalRoot: string; lexicalPath: string } {
  assertValidPath(path);
  const canonicalRoot = canonicalizeProjectRoot(projectRoot);
  const lexicalPath = resolve(canonicalRoot, ...path.split("/"));
  assertContained(canonicalRoot, lexicalPath, path);
  return { canonicalRoot, lexicalPath };
}

function assertValidPath(path: string): asserts path is RepoRelativePath {
  if (
    !isRepoRelativePath(path)
    || /[\u0000-\u001f\u007f]/.test(path)
    || Buffer.byteLength(path, "utf8") > 4096
  ) {
    throw artifactError(
      "PATH_OUTSIDE_PROJECT",
      "Unsafe repository path",
      "Artifact paths must be bounded canonical repository-relative paths.",
    );
  }
}

function assertContained(root: string, candidate: string, path: RepoRelativePath): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw unsafePath(path, "Artifact path escapes the project root.");
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

function identityOf(value: FileIdentity): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function unlinkOwnedLock(path: string, expected: FileIdentity): void {
  try {
    const current = lstatSync(path);
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, expected)) {
      unlinkSync(path);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unsupported on some otherwise supported platforms.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function unsafePath(path: RepoRelativePath, detail: string): Error {
  return artifactError("PATH_OUTSIDE_PROJECT", "Unsafe artifact path", detail, path);
}

function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isNotFound(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

function isMexCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "problem" in error
    && (error as { problem?: { code?: unknown } }).problem?.code === code;
}

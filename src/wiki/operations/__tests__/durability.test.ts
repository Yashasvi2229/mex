import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_FSYNC_SUPPORTED,
  DirectorySyncError,
  syncDirectory,
  syncDirectoryUnconditionally,
} from "../durability.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-durability-"));
  roots.push(root);
  return root;
}

describe("directory fsync", () => {
  it("names the one platform that cannot flush a directory handle", () => {
    // The claim is about the operating system, not about an error, so it is
    // asserted as such. Windows has no directory flush; everything else is
    // expected to have one and is held to it.
    expect(DIRECTORY_FSYNC_SUPPORTED).toBe(process.platform !== "win32");
  });

  it("is a no-op rather than a throw where the platform cannot do it", () => {
    // The whole of defect 1. `constants.O_DIRECTORY` is `undefined` on Windows,
    // so `O_RDONLY | (O_DIRECTORY ?? 0)` opens the directory as an ordinary
    // file — the open *succeeds* — and `fsyncSync` on that handle throws
    // `EPERM`. Every Wiki write went through this, so the write path was
    // unusable on Windows and 142 tests were red for it.
    expect(() => syncDirectory(temporaryDirectory())).not.toThrow();
  });

  it("reports a failure as a durability failure, with the original errno in the message", () => {
    // The second half of defect 1: the failure used to be rethrown as
    // `OperationLogPathError`, which says "this path is not one I may touch"
    // and sends a reader to their scaffold layout for a problem in the
    // filesystem. It now surfaces as itself, and the cause is *printed* rather
    // than merely retained — a cause nobody prints is a cause nobody reads.
    const missing = join(temporaryDirectory(), "not-a-directory-that-exists");
    let caught: unknown;
    try {
      syncDirectoryUnconditionally(missing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DirectorySyncError);
    expect((caught as DirectorySyncError).path).toBe(missing);
    expect((caught as Error).message).toContain("ENOENT");
    expect((caught as Error).message).toContain(JSON.stringify(missing));
    expect((caught as DirectorySyncError).cause).toBeInstanceOf(Error);
  });

  it.runIf(!DIRECTORY_FSYNC_SUPPORTED)(
    "surfaces the platform's own EPERM when the guard is bypassed",
    () => {
      // Drives the unguarded call on the platform that provoked all of this, so
      // the guard is verified against the real failure rather than against a
      // belief about it. Skipped where directory fsync works.
      let caught: unknown;
      try {
        syncDirectoryUnconditionally(temporaryDirectory());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DirectorySyncError);
      expect((caught as Error).message).toContain("EPERM");
    },
  );
});

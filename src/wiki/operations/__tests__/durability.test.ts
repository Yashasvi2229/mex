import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_FSYNC_SUPPORTED,
  DirectorySyncError,
  syncDirectory,
  syncDirectoryUnconditionally,
} from "../durability.js";
import { appendAudit, readOperationLogExact, type AuditEntry } from "../audit.js";

const roots: string[] = [];

const ENTRY: AuditEntry = {
  v: 1,
  phase: "complete",
  opId: "op_durability_probe",
  type: "create-entry",
  entityIds: [],
  createdIds: [],
  actor: { kind: "human", id: "durability-probe" },
  timestamp: "2026-09-01T00:00:00.000Z",
  files: [],
  payloadHash: "0".repeat(64),
  revisions: [],
};

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

describe("the exact ledger read's file identity check", () => {
  it("compares inode identity at full width, not through a double", () => {
    // A plain `lstatSync` reports `ino` as a JavaScript number. An NTFS file id
    // is a 64-bit value far past 2^53 — a measured one on this machine is
    // 73183493944776897, which comes back from a non-bigint stat as
    // 73183493944776900 and converts to 73183493944776896n. Widening a rounded
    // double to a BigInt cannot recover the bits the double dropped, so
    // `readOperationLogExact` compared an inexact id against the exact one from
    // `fstatSync(fd, { bigint: true })` and threw on every read.
    //
    // Asserted about the platform's own stat rather than about the wiki, so it
    // says what actually went wrong. Where a file id fits in a double the two
    // agree and the check was merely lucky; here it never could.
    const root = temporaryDirectory();
    const probe = join(root, "identity-probe");
    writeFileSync(probe, "{}\n", "utf-8");
    const fd = openSync(probe, constants.O_RDONLY);
    try {
      const opened = fstatSync(fd, { bigint: true });
      expect(lstatSync(probe, { bigint: true }).ino).toBe(opened.ino);
      if (opened.ino > BigInt(Number.MAX_SAFE_INTEGER)) {
        expect(BigInt(lstatSync(probe).ino)).not.toBe(opened.ino);
      }
    } finally {
      closeSync(fd);
    }
  });

  it("reads back a ledger it has just written", () => {
    // The end of the failure this caused: every exact read threw
    // `OperationLogPathError`, the write path rolled back, the rollback's own
    // read threw the same way, and the caller got `WikiWriteRecoveryError` with
    // no reason attached. Twenty-nine tests in `src/wiki` failed as that.
    const root = temporaryDirectory();
    mkdirSync(join(root, "events"), { recursive: true });
    expect(readOperationLogExact(root)).toEqual({ exists: false, text: "" });

    appendAudit(root, ENTRY);
    const read = readOperationLogExact(root);
    expect(read.exists).toBe(true);
    expect(read.text).toBe(`${JSON.stringify(ENTRY)}\n`);
  });
});

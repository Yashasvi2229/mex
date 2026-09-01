import { createHash } from "node:crypto";
import type { Revision } from "../contracts/shared.js";

/**
 * SHA-256 of the exact bytes supplied; callers must not normalize first.
 *
 * The one transform that happens before this is Git's checkout line-ending
 * conversion being undone, in `readContainedArtifact` — see
 * `undoCheckoutLineEndings`. That is not a normalization of the artifact; it is
 * the removal of one Git applied to the working tree, and without it the same
 * committed artifact hashes to a different revision on Windows than on macOS.
 */
export function revisionOf(bytes: string | Uint8Array): Revision {
  return createHash("sha256").update(bytes).digest("hex") as Revision;
}

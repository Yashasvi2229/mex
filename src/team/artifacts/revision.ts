import { createHash } from "node:crypto";
import type { Revision } from "../contracts/shared.js";

/** SHA-256 of the exact bytes supplied; callers must not normalize first. */
export function revisionOf(bytes: string | Uint8Array): Revision {
  return createHash("sha256").update(bytes).digest("hex") as Revision;
}

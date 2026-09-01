import { createHash } from "node:crypto";
import type {
  AgentAssetActionName,
  AgentInstructionChange,
  AgentSkillClient,
} from "./types.js";
import { AGENT_SKILL_TARGETS } from "./types.js";

export const MEX_INSTRUCTIONS_START = "<!-- mex-agent:skills:start -->";
export const MEX_INSTRUCTIONS_END = "<!-- mex-agent:skills:end -->";
export const MAX_MANAGED_INSTRUCTION_PREVIEW_BYTES = 32 * 1024;

/**
 * Exact pre-managed-block MEX outputs. Hashes remain stable even after the
 * source templates change, allowing only byte-for-byte legacy files to be
 * replaced wholesale. Hand-edited descendants do not match and are appended.
 */
export const KNOWN_LEGACY_INSTRUCTION_SHA256: Readonly<
  Record<AgentSkillClient, readonly string[]>
> = {
  claude: [
    "2ba41ed19c039420d60e2f6da930b9c7de999ecfd5f96fd236fd39df8c952eec",
    "ee60a376430adccfcc24b5c880f6b5a449c1c959a039dc047f057bd80907ee91",
  ],
  codex: [
    "ee60a376430adccfcc24b5c880f6b5a449c1c959a039dc047f057bd80907ee91",
  ],
};

export interface ManagedInstructionEdit {
  readonly action: Extract<AgentAssetActionName, "create" | "migrate" | "update" | "noop" | "conflict">;
  readonly desiredBytes?: Uint8Array;
  readonly instructionChange?: AgentInstructionChange;
  readonly reason:
    | "absent"
    | "legacy"
    | "append"
    | "replace"
    | "exact"
    | "managed-block-too-large"
    | "malformed-markers"
    | "invalid-encoding";
}

/** Generate the short, client-aware policy block. Procedures live in the skills. */
export function renderManagedInstructionBlock(
  client: AgentSkillClient,
  eol = "\n",
): string {
  const target = AGENT_SKILL_TARGETS[client];
  const inbox = `${target.invocationPrefix}mex-inbox`;
  const relay = `${target.invocationPrefix}mex-relay`;
  return [
    MEX_INSTRUCTIONS_START,
    "## MEX agent skills",
    `- Use \`${inbox}\` for durable governed Spec proposals and \`${relay}\` for durable team handoffs. Invoke them automatically when intent clearly matches; explicit invocation remains available.`,
    "- When MEX context materially influences an answer or implementation, include one concise acknowledgement: `MEX context used: <specific records/files/entities consulted>.`",
    "- Do not claim an author, date, or historical event unless the retrieved data actually provides it.",
    "- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.",
    "- Skill activation is not approval for canonical actions.",
    MEX_INSTRUCTIONS_END,
  ].join(eol);
}

/**
 * Compute an instruction-file edit without writing. Existing bytes outside a
 * valid managed block are copied byte-for-byte into the desired output.
 */
export function planManagedInstructionEdit(
  client: AgentSkillClient,
  currentBytes: Uint8Array | null,
  additionalLegacyHashes: readonly string[] = [],
): ManagedInstructionEdit {
  if (currentBytes === null) {
    const after = renderManagedInstructionBlock(client);
    return {
      action: "create",
      desiredBytes: Buffer.from(`${after}\n`, "utf8"),
      instructionChange: { scope: "create", before: null, after },
      reason: "absent",
    };
  }

  let current: string;
  try {
    // `ignoreBOM: true` counterintuitively means "do not consume the BOM".
    // Keeping U+FEFF in the decoded string preserves the original BOM bytes.
    current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(currentBytes);
  } catch {
    return { action: "conflict", reason: "invalid-encoding" };
  }

  const starts = allIndexesOf(current, MEX_INSTRUCTIONS_START);
  const ends = allIndexesOf(current, MEX_INSTRUCTIONS_END);
  if (starts.length === 0 && ends.length === 0) {
    const currentHash = sha256(currentBytes);
    const legacyHashes = new Set([
      ...KNOWN_LEGACY_INSTRUCTION_SHA256[client],
      ...additionalLegacyHashes.map((hash) => hash.toLowerCase()),
    ]);
    if (legacyHashes.has(currentHash)) {
      const eol = detectEol(current);
      const after = renderManagedInstructionBlock(client, eol);
      return {
        action: "migrate",
        desiredBytes: Buffer.from(`${after}${eol}`, "utf8"),
        instructionChange: {
          scope: "known-legacy-migration",
          before: null,
          after,
        },
        reason: "legacy",
      };
    }

    const eol = detectEol(current);
    const after = renderManagedInstructionBlock(client, eol);
    const separator = current.length === 0 ? "" : current.endsWith("\n") ? eol : `${eol}${eol}`;
    const desired = `${current}${separator}${after}${eol}`;
    return {
      action: "update",
      desiredBytes: Buffer.from(desired, "utf8"),
      instructionChange: { scope: "append", before: null, after },
      reason: "append",
    };
  }

  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    starts[0]! >= ends[0]! ||
    !isStandaloneMarker(current, starts[0]!, MEX_INSTRUCTIONS_START) ||
    !isStandaloneMarker(current, ends[0]!, MEX_INSTRUCTIONS_END)
  ) {
    return { action: "conflict", reason: "malformed-markers" };
  }

  const eol = detectEol(current);
  const before = current.slice(starts[0]!, ends[0]! + MEX_INSTRUCTIONS_END.length);
  if (Buffer.byteLength(before, "utf8") > MAX_MANAGED_INSTRUCTION_PREVIEW_BYTES) {
    return { action: "conflict", reason: "managed-block-too-large" };
  }
  const after = renderManagedInstructionBlock(client, eol);
  const desired =
    current.slice(0, starts[0]!) +
    after +
    current.slice(ends[0]! + MEX_INSTRUCTIONS_END.length);
  if (desired === current) {
    return { action: "noop", reason: "exact" };
  }
  return {
    action: "update",
    desiredBytes: Buffer.from(desired, "utf8"),
    instructionChange: { scope: "replace", before, after },
    reason: "replace",
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectEol(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function allIndexesOf(content: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const found = content.indexOf(needle, offset);
    if (found < 0) break;
    indexes.push(found);
    offset = found + needle.length;
  }
  return indexes;
}

function isStandaloneMarker(content: string, index: number, marker: string): boolean {
  const before = index === 0 ? "" : content[index - 1];
  const afterIndex = index + marker.length;
  const after = afterIndex === content.length ? "" : content[afterIndex];
  const beginsLine = before === "" || before === "\n";
  const endsLine = after === "" || after === "\n" || (after === "\r" && content[afterIndex + 1] === "\n");
  return beginsLine && endsLine;
}

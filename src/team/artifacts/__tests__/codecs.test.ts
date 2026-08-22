import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepoRelativePath } from "../../contracts/shared.js";
import type { ActivityEvent } from "../../contracts/workflow.js";
import {
  activityArtifactPath,
  memberArtifactPath,
  parseActivityArtifact,
  parseMemberArtifact,
  serializeActivityArtifact,
  serializeMemberArtifact,
} from "../codecs.js";
import { atomicCreateArtifact } from "../filesystem.js";
import { revisionOf } from "../revision.js";
import { generateArtifactId } from "../ulid.js";

const MEMBER_ID = generateArtifactId("member", {
  now: Date.UTC(2026, 7, 23),
  random: new Uint8Array(10).fill(1),
});
const EVENT_ID = generateArtifactId("event", {
  now: Date.UTC(2026, 7, 23),
  random: new Uint8Array(10).fill(2),
});

describe("member artifact codec", () => {
  it("serializes deterministic frontmatter, sorts aliases, and hashes exact bytes", () => {
    const document = serializeMemberArtifact({
      id: MEMBER_ID,
      displayName: "Ada Lovelace",
      gitAliases: [
        { name: "Ada", email: "ada@example.com" },
        { name: "Lovelace", email: null },
      ],
      active: true,
    });

    expect(document).toBe([
      "---",
      "schema_version: 1",
      `id: ${JSON.stringify(MEMBER_ID)}`,
      "display_name: \"Ada Lovelace\"",
      "git_aliases: [{\"email\":null,\"name\":\"Lovelace\"},{\"email\":\"ada@example.com\",\"name\":\"Ada\"}]",
      "active: true",
      "---",
      "",
    ].join("\n"));

    const path = memberArtifactPath(MEMBER_ID);
    const parsed = parseMemberArtifact(Buffer.from(document, "utf8"), path);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      ref: { id: MEMBER_ID, kind: "member", title: "Ada Lovelace" },
      kind: "member",
      sourcePath: path,
      revision: revisionOf(document),
      active: true,
    });
    expect(parsed.gitAliases).toEqual([
      { name: "Lovelace", email: null },
      { name: "Ada", email: "ada@example.com" },
    ]);
  });

  it("rejects invalid aliases, mismatched paths, CRLF, bodies, and noncanonical key order", () => {
    expect(() => serializeMemberArtifact({
      id: MEMBER_ID,
      displayName: "Ada",
      gitAliases: [{ name: null, email: null }],
      active: true,
    })).toThrow(/name or email/);

    const canonical = serializeMemberArtifact({
      id: MEMBER_ID,
      displayName: "Ada",
      gitAliases: [],
      active: true,
    });
    expect(() => parseMemberArtifact(
      canonical,
      `.mex/team/members/${EVENT_ID}.md` as RepoRelativePath,
    )).toThrow(/Member path/);
    expect(() => parseMemberArtifact(
      canonical.replaceAll("\n", "\r\n"),
      memberArtifactPath(MEMBER_ID),
    )).toThrow(/LF line endings/);
    expect(() => parseMemberArtifact(
      `${canonical}body\n`,
      memberArtifactPath(MEMBER_ID),
    )).toThrow(/frontmatter only/);
    expect(() => parseMemberArtifact(
      canonical.replace("schema_version: 1\n", "").replace("id:", `id:\n schema_version: 1\nignored:`),
      memberArtifactPath(MEMBER_ID),
    )).toThrow();
    const reordered = canonical
      .replace(`schema_version: 1\nid: ${JSON.stringify(MEMBER_ID)}`, `id: ${JSON.stringify(MEMBER_ID)}\nschema_version: 1`);
    expect(() => parseMemberArtifact(reordered, memberArtifactPath(MEMBER_ID))).toThrow(/canonical/);
  });
});

describe("activity artifact codec", () => {
  it("round-trips all stable subject forms with recursively sorted metadata", () => {
    const event = sampleEvent({
      metadata: { z: 1, a: { safe: true } },
    });
    const alternate = sampleEvent({
      metadata: { a: { safe: true }, z: 1 },
    });

    const document = serializeActivityArtifact(event);
    expect(serializeActivityArtifact(alternate)).toBe(document);
    expect(document).toContain("metadata: {\"a\":{\"safe\":true},\"z\":1}");
    expect(document.endsWith("---\n")).toBe(true);

    const path = activityArtifactPath(event);
    expect(path).toBe(`.mex/events/activity/2026-08/${EVENT_ID}.md`);
    const parsed = parseActivityArtifact(document, path);
    expect(parsed).toEqual({
      ...event,
      metadata: { a: { safe: true }, z: 1 },
      sourcePath: path,
      revision: revisionOf(document),
    });
  });

  it.each([
    "prompt",
    "transcript",
    "chain_of_thought",
    "source_dump",
    "diff",
    "patch",
    "secret",
    "password",
    "token",
    "api_key",
    "private_key",
    "system_prompt",
    "raw_source_dump",
    "api_token_value",
    "__proto__",
    "constructor",
  ])("rejects prohibited metadata family %s", (key) => {
    expect(() => serializeActivityArtifact(sampleEvent({
      metadata: { [key]: "must not persist" },
    }))).toThrow(/must not contain/);
  });

  it("enforces metadata, timestamp, path, commit, and canonical-byte constraints", () => {
    const tooManyEntries = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
    );
    expect(() => serializeActivityArtifact(sampleEvent({ metadata: tooManyEntries }))).toThrow(/32 entries/);
    expect(() => serializeActivityArtifact(sampleEvent({ timestamp: "2026-08-23T01:02:03Z" }))).toThrow(/exact UTC/);
    expect(() => serializeActivityArtifact(sampleEvent({
      subjects: [{ kind: "commit", hash: "not-a-hash" }],
    }))).toThrow(/Commit subject hash/);
    expect(() => serializeActivityArtifact(sampleEvent({
      subjects: [{ kind: "file", path: `src/${"a".repeat(4096)}` }],
    }))).toThrow(/canonical repository-relative path/);
    expect(() => serializeActivityArtifact(sampleEvent({
      subjects: [{ kind: "file", path: "src/e\u0301.ts" }],
    }))).toThrow(/canonical repository-relative path/);

    const event = sampleEvent();
    const document = serializeActivityArtifact(event);
    expect(() => parseActivityArtifact(
      document,
      `.mex/events/activity/2026-07/${EVENT_ID}.md` as RepoRelativePath,
    )).toThrow(/Activity path/);
    const aliased = [
      "---",
      "schema_version: 1",
      `id: ${JSON.stringify(EVENT_ID)}`,
      "timestamp: &when \"2026-08-23T01:02:03.000Z\"",
      "actor: {\"kind\":\"unknown\"}",
      "action: \"member.observed\"",
      "subjects: []",
      "repo_state: {\"branch\":\"main\",\"dirty\":false,\"head\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"observedAt\":*when}",
      "---",
      "",
    ].join("\n");
    expect(() => parseActivityArtifact(aliased, activityArtifactPath(event))).toThrow(/YAML|canonical/);
  });

  it("rejects a fully valid event whose canonical bytes exceed the immutable file cap", () => {
    const subjects = Array.from({ length: 64 }, (_, index) => ({
      kind: "code" as const,
      code: {
        kind: "symbol" as const,
        symbolId: `${String(index).padStart(3, "0")}${"s".repeat(509)}`,
        fingerprint: "f".repeat(512),
      },
    }));
    expect(() => serializeActivityArtifact(sampleEvent({ subjects }))).toThrow(/65536 bytes/);
  });

  it("rejects an oversized immutable event before any artifact can be created", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-activity-cap-"));
    const event = sampleEvent({
      subjects: Array.from({ length: 64 }, (_, index) => ({
        kind: "code" as const,
        code: {
          kind: "symbol" as const,
          symbolId: `${String(index).padStart(3, "0")}${"s".repeat(509)}`,
          fingerprint: "f".repeat(512),
        },
      })),
    });
    const path = activityArtifactPath(event);
    try {
      expect(() => {
        const document = serializeActivityArtifact(event);
        atomicCreateArtifact(root, path, document);
      }).toThrow(/65536 bytes/);
      expect(existsSync(join(root, ...path.split("/")))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function sampleEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    schemaVersion: 1,
    id: EVENT_ID,
    timestamp: "2026-08-23T01:02:03.000Z",
    actor: { kind: "member", memberId: MEMBER_ID, displayName: "Ada Lovelace" },
    action: "member.observed",
    subjects: [
      { kind: "entity", entity: { id: MEMBER_ID, kind: "member", title: "Ada Lovelace" } },
      { kind: "file", path: "src/events.ts" },
      { kind: "code", code: { kind: "symbol", symbolId: "function:abc" } },
      { kind: "commit", hash: "a".repeat(40) },
    ],
    workstream: { id: "ws_01K3Q080000000000000000000", kind: "workstream", title: "Lane C" },
    repoState: {
      branch: "main",
      head: "b".repeat(40),
      dirty: true,
      observedAt: "2026-08-23T01:02:02.000Z",
    },
    ...overrides,
  };
}

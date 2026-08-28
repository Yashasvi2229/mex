import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { TEAM_INBOX_SPEC_LIMITS } from "../../../contracts/workflow.js";
import { runInboxContract } from "../contract.js";

describe("Inbox contract resolver CLI", () => {
  it("returns one bounded static catalog whose roots and examples strict-compile", () => {
    const lines: string[] = [];
    let exit = -1;
    runInboxContract(
      { json: true },
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );

    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!, "utf8")).toBeLessThanOrEqual(
      TEAM_INBOX_SPEC_LIMITS.maxEnvelopeBytes,
    );
    const envelope = JSON.parse(lines[0]!) as {
      schemaVersion: number;
      command: string;
      mode: string;
      ok: boolean;
      data: {
        catalog: Record<string, unknown>;
        requestFile: { schemaRef: string; examples: Array<{ request: unknown }> };
        applyFile: { schemaRef: string; requirement: string };
      };
    };
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      command: "inbox.contract",
      mode: "read",
      ok: true,
      data: {
        catalogVersion: 1,
        contractId: "team.inbox.contract-catalog.v1",
        mediaType: "application/schema+json",
        encoding: "utf-8",
      },
    });
    expect(envelope.data.applyFile.requirement).toContain("exact complete successful");

    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(envelope.data.catalog);
    const validateRequest = ajv.compile({ $ref: envelope.data.requestFile.schemaRef });
    const validatePreview = ajv.compile({ $ref: envelope.data.applyFile.schemaRef });
    expect(validatePreview).toBeTypeOf("function");
    for (const name of [
      "operationId", "revision", "memberId", "workstreamId", "canonicalText", "gitAlias",
      "memberArtifactExpectation", "workstreamArtifactExpectation", "entityExpectation",
      "artifactExpectation", "localExpectation", "expectation", "expectations",
      "nonEmptyExpectations", "entityRef", "codeRef", "actorRef", "canonicalRepoPath",
      "actorSet", "entitySet", "codeSet", "pathSet", "workstreamCreateInput",
      "workstreamUpdatePatch", "activitySubject", "memberAddAction", "memberUpdateAction",
      "memberDeactivateAction", "memberSelectAction", "memberClearAction",
      "activityRecordAction", "workstreamCreateAction", "workstreamUpdateAction",
      "workstreamArchiveAction", "memberAddRequest", "memberUpdateRequest",
      "memberDeactivateRequest", "memberSelectRequest", "memberSelectOnlyRequest",
      "memberClearRequest", "activityRecordRequest", "workstreamCreateRequest",
      "workstreamUpdateRequest", "workstreamArchiveRequest",
    ]) {
      expect(ajv.compile({
        $ref: `https://mex.dev/contracts/team-identity-activity-request-v1.json#/$defs/${name}`,
      })).toBeTypeOf("function");
    }
    for (const example of envelope.data.requestFile.examples) {
      expect(validateRequest(example.request), JSON.stringify(validateRequest.errors)).toBe(true);
    }

    const legacyRef = (name: string) => ajv.compile({
      $ref: `https://mex.dev/contracts/team-identity-activity-request-v1.json#/$defs/${name}`,
    });
    const memberId = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const revision = "a".repeat(64);
    const memberExpectation = {
      target: { kind: "artifact", path: `.mex/team/members/${memberId}.md` },
      revision,
    };
    expect(legacyRef("memberArtifactExpectation")(memberExpectation)).toBe(true);
    expect(legacyRef("memberArtifactExpectation")({
      target: { kind: "artifact", path: ".mex/team/members/not-a-member.md" },
      revision: null,
    })).toBe(false);
    expect(legacyRef("memberDeactivateAction")({ kind: "member.deactivate", memberId })).toBe(true);
    expect(legacyRef("memberDeactivateAction")({ kind: "member.select", memberId })).toBe(false);
    expect(legacyRef("memberSelectAction")({ kind: "member.select", memberId })).toBe(true);
    expect(legacyRef("memberSelectAction")({ kind: "member.deactivate", memberId })).toBe(false);
    const request = (kind: "member.select" | "member.clear") => ({
      operationId: `legacy-${kind}`,
      action: kind === "member.select" ? { kind, memberId } : { kind },
      expectedRevisions: [memberExpectation],
    });
    expect(legacyRef("memberSelectOnlyRequest")(request("member.select"))).toBe(true);
    expect(legacyRef("memberSelectOnlyRequest")(request("member.clear"))).toBe(false);
    expect(legacyRef("memberClearRequest")(request("member.clear"))).toBe(true);
    expect(legacyRef("memberClearRequest")(request("member.select"))).toBe(false);
  });

  it("does not require JSON mode to remain bounded or touch a service", () => {
    const lines: string[] = [];
    let exit = -1;
    runInboxContract(
      {},
      { write: (line) => lines.push(line), setExitCode: (code) => { exit = code; } },
    );
    expect(exit).toBe(0);
    expect(lines).toEqual([
      "Run mex inbox contract --json to emit the versioned machine contract catalog.",
    ]);
  });
});

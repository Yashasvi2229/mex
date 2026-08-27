import {
  ActivityResponseSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  JobPageResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewResponseSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityListResponseSchema,
  WikiRelationsResponseSchema,
} from "@mex/hub-contracts";
import { describe, expect, it } from "vitest";
import { createFixtureApi } from "./fixture-api";

describe("development-only populated fixture", () => {
  it("stays inside every shared wire contract", async () => {
    const api = createFixtureApi();
    const [session, capabilities, home, activity, search, code, health, jobs, entities, detail, relations, backlinks, codeKnowledge] = await Promise.all([
      api.getSession(),
      api.getCapabilities(),
      api.getHome(),
      api.getActivity({ limit: 25 }),
      api.search({ q: "bootstrap", limit: 25 }),
      api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 2 }),
      api.getHealth(),
      api.getJobs(),
      api.listWikiEntities({ limit: 25 }),
      api.getWikiEntity("mx_01K36WVM6H7JK8M9NPQRSTVVWX"),
      api.getWikiRelations("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { direction: "both", limit: 25 }),
      api.getWikiBacklinks("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { limit: 25 }),
      api.getCodeKnowledge("sym.createHubServer", { limit: 25 }),
    ]);

    expect(SessionResponseSchema.safeParse(session).success).toBe(true);
    expect(HubCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(HomeResponseSchema.safeParse(home).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(activity).success).toBe(true);
    expect(home.sections.activity).toEqual({ availability: "available", count: 4 });
    expect(home.sections.inbox.availability).toBe("unavailable");
    expect(home.sections.relays.availability).toBe("unavailable");
    expect(activity.items.some((item) => item.source === "activity")).toBe(true);
    expect(activity.items.some((item) => item.source === "legacy")).toBe(true);
    expect(SearchResponseSchema.safeParse(search).success).toBe(true);
    expect(CodeWorkspaceResponseSchema.safeParse(code).success).toBe(true);
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(JobPageResponseSchema.safeParse(jobs).success).toBe(true);
    expect(jobs.items.every((job) => HubJobSnapshotSchema.safeParse(job).success)).toBe(true);
    const entityPage = WikiEntityListResponseSchema.safeParse(entities);
    expect(entityPage.success, entityPage.success ? undefined : entityPage.error.message).toBe(true);
    expect(WikiEntityDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(WikiRelationsResponseSchema.safeParse(relations).success).toBe(true);
    expect(WikiBacklinksResponseSchema.safeParse(backlinks).success).toBe(true);
    expect(CodeKnowledgeResponseSchema.safeParse(codeKnowledge).success).toBe(true);

    const members = await api.getMembers({ limit: 25 });
    const member = await api.getMember(members.items[0]!.id);
    const currentActor = await api.getCurrentActor();
    expect(TeamMemberListResponseSchema.safeParse(members).success).toBe(true);
    expect(TeamMemberSchema.safeParse(member).success).toBe(true);
    expect(TeamCurrentActorResponseSchema.safeParse(currentActor).success).toBe(true);

    const preview = await api.previewTeamOperation({
      operationId: "fixture_member_select_contract",
      action: { kind: "member.select", memberId: members.items[1]!.id },
      expectedRevisions: [
        {
          target: { kind: "artifact", path: members.items[1]!.sourcePath },
          revision: members.items[1]!.revision,
        },
        {
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: currentActor.selection?.revision ?? null,
        },
      ],
    });
    const applied = await api.applyTeamOperation(preview);
    expect(TeamOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(TeamOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.events).toEqual([]);
    expect((await api.getCurrentActor()).selection?.memberId).toBe(members.items[1]!.id);
  });
});

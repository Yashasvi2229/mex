import {
  ActivityResponseSchema,
  CodeWorkspaceResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  JobPageResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
} from "@mex/hub-contracts";
import { describe, expect, it } from "vitest";
import { createFixtureApi } from "./fixture-api";

describe("development-only populated fixture", () => {
  it("stays inside every shared wire contract", async () => {
    const api = createFixtureApi();
    const [session, capabilities, home, activity, search, code, health, jobs] = await Promise.all([
      api.getSession(),
      api.getCapabilities(),
      api.getHome(),
      api.getActivity({ limit: 25 }),
      api.search({ q: "bootstrap", limit: 25 }),
      api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 2 }),
      api.getHealth(),
      api.getJobs(),
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
  });
});

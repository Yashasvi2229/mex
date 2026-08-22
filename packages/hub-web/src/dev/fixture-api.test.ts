import {
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
    const [session, capabilities, home, search, health, jobs] = await Promise.all([
      api.getSession(),
      api.getCapabilities(),
      api.getHome(),
      api.search("bootstrap"),
      api.getHealth(),
      api.getJobs(),
    ]);

    expect(SessionResponseSchema.safeParse(session).success).toBe(true);
    expect(HubCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(HomeResponseSchema.safeParse(home).success).toBe(true);
    expect(SearchResponseSchema.safeParse(search).success).toBe(true);
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(JobPageResponseSchema.safeParse(jobs).success).toBe(true);
    expect(jobs.items.every((job) => HubJobSnapshotSchema.safeParse(job).success)).toBe(true);
  });
});

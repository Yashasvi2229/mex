import { describe, expect, it } from "vitest";
import {
  BootstrapRequestSchema,
  HUB_LIMITS,
  HomeResponseSchema,
  HubJobIdSchema,
  SearchRequestSchema,
  SearchResponseSchema,
} from "./index.js";

describe("Hub API contracts", () => {
  it("rejects unknown request fields and oversized queries", () => {
    expect(BootstrapRequestSchema.safeParse({
      token: Buffer.alloc(32).toString("base64url"),
      unexpected: true,
    }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({
      q: "x".repeat(HUB_LIMITS.maxQueryCharacters + 1),
    }).success).toBe(false);
  });

  it("applies bounded page defaults", () => {
    expect(SearchRequestSchema.parse({ q: "memory" })).toEqual({
      q: "memory",
      limit: HUB_LIMITS.defaultPageSize,
    });
  });

  it("accepts only standard prefixed ULIDs for Hub jobs", () => {
    expect(HubJobIdSchema.safeParse("job_01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
    expect(HubJobIdSchema.safeParse(`job_8${"0".repeat(25)}`).success).toBe(false);
    expect(HubJobIdSchema.safeParse(`job_Z${"0".repeat(25)}`).success).toBe(false);
  });

  it("requires unavailable production summaries to be honest", () => {
    const response = {
      observedAt: "2026-08-23T00:00:00.000Z",
      repository: {
        scaffoldId: "mex",
        name: "mex",
        branch: "feat/hub",
        head: "a".repeat(40),
        dirty: false,
      },
      actor: { kind: "unknown" },
      sections: {
        workstreams: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        relays: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        inbox: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        activity: { availability: "available", count: 0 },
      },
      activeJobs: 0,
      attention: [],
    };
    expect(HomeResponseSchema.safeParse(response).success).toBe(true);
    expect(HomeResponseSchema.safeParse({
      ...response,
      sections: {
        ...response.sections,
        workstreams: { availability: "unavailable", count: 12 },
      },
    }).success).toBe(false);
  });

  it("keeps grouped search failures independent and result-free", () => {
    const unavailable = {
      status: "unavailable",
      items: [],
      nextCursor: null,
      truncated: false,
      detail: "The adapter is not installed.",
    } as const;
    const response = {
      query: "router",
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailable,
        symbols: {
          status: "available",
          items: [{ id: "symbol:router", kind: "code_symbol", title: "Router" }],
          nextCursor: null,
          truncated: false,
        },
        sources: unavailable,
      },
    };
    expect(SearchResponseSchema.safeParse(response).success).toBe(true);
    expect(SearchResponseSchema.safeParse({
      ...response,
      groups: {
        ...response.groups,
        wiki: { ...unavailable, items: [{ id: "fake", kind: "wiki", title: "Fake" }] },
      },
    }).success).toBe(false);
  });
});

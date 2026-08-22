import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitPort } from "../../team/contracts/git.js";
import { createLocalHubReadServices } from "../services.js";

const git = {
  getRepoState: async () => ({
    branch: "feat/project-hub-foundation",
    head: "a".repeat(40),
    dirty: true,
    observedAt: "2026-08-23T00:00:00.000Z",
  }),
  getIdentity: async () => ({ name: "Daksh", email: "daksh@example.test" }),
} as Pick<GitPort, "getRepoState" | "getIdentity"> as GitPort;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-services-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("createLocalHubReadServices", () => {
  it("uses real repository context without inventing unavailable project data", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });

    await expect(services.home()).resolves.toMatchObject({
      repository: {
        name: expect.stringMatching(/^mex-hub-services-/),
        branch: "feat/project-hub-foundation",
        dirty: true,
      },
      actor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      sections: {
        workstreams: { availability: "unavailable", count: null },
        relays: { availability: "unavailable", count: null },
        inbox: { availability: "unavailable", count: null },
        activity: { availability: "unavailable", count: null },
      },
      activeJobs: 0,
      attention: [],
    });
  });

  it("keeps Wiki and graph search groups independently unavailable", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki.status).toBe("unavailable");
    expect(result.groups.symbols.status).toBe("unavailable");
    expect(result.groups.sources.status).toBe("unavailable");
    expect(result.groups.wiki.items).toEqual([]);
  });

  it("reports foundation health honestly", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });

    const health = await services.health();
    expect(health.status).toBe("degraded");
    expect(health.components.map((component) => [component.id, component.status])).toEqual([
      ["git", "healthy"],
      ["local_state", "healthy"],
      ["migration", "healthy"],
      ["graph", "unavailable"],
      ["wiki", "unavailable"],
    ]);
  });
});

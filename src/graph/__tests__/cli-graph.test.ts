import { describe, expect, it } from "vitest";
import type { GraphSourceChanges } from "../../team/contracts/graph.js";
import { formatGraphSourceChanges } from "../cli-graph.js";

function changes(overrides: Partial<GraphSourceChanges> = {}): GraphSourceChanges {
  return {
    total: 0,
    added: [],
    modified: [],
    deleted: [],
    truncated: false,
    branchChanged: false,
    manifestChanged: false,
    configChanged: false,
    grammarChanged: false,
    ...overrides,
  };
}

describe("graph CLI status formatting", () => {
  it("labels bounded path arrays as shown instead of an exact breakdown", () => {
    const rendered = formatGraphSourceChanges(changes({
      total: 125,
      added: ["src/a.ts"],
      modified: ["src/b.ts", "src/c.ts"],
      truncated: true,
    }));

    expect(rendered).toBe(
      "Sources: 125 changed (1 added shown, 2 modified shown, 0 deleted shown; 122 paths omitted)",
    );
    expect(rendered).not.toContain("1 added, 2 modified, 0 deleted");
  });
});

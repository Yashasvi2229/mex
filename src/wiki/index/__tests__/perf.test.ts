/**
 * Order-of-magnitude performance, against D10's calibration targets.
 *
 * **The thresholds are 10x the targets, not the targets.** A perf test that
 * fails at target fails on a loaded CI box, and a test that fails for reasons
 * nobody can fix gets disabled — after which it protects nothing at all. What
 * is worth catching here is the accidental O(n²): a refresh that reparses the
 * whole scaffold, a query that forgot its index, a rebuild that resolves
 * references inside its own loop. Each of those is one to three orders of
 * magnitude, and each shows up plainly at this threshold.
 *
 * The corpus is a tenth of D10's calibration size, and the thresholds are
 * scaled to match, so the whole file stays under a few seconds.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { rebuildWikiIndex } from "../rebuild.js";
import { refreshWikiIndex } from "../refresh.js";
import { getEntity, listEntities, relatedEntities, searchEntities } from "../../query/get.js";
import { createScaffold, steppingClock, type Scaffold } from "./harness.js";

/** 100 files x 5 entities: a tenth of D10's 1,000 files / 5,000 entities. */
const FILES = 100;
const ENTITIES_PER_FILE = 5;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A distinct, well-formed entity id per index. */
function idFor(index: number): string {
  let suffix = "";
  let remaining = index;
  for (let position = 0; position < 6; position += 1) {
    suffix = ALPHABET[remaining % 32]! + suffix;
    remaining = Math.floor(remaining / 32);
  }
  return `mx_01KR2E4K002H3ZYA9G0C${suffix}`;
}

let scaffold: Scaffold;
let indexPath: string;

function fileText(fileIndex: number): string {
  let text = "";
  for (let entity = 0; entity < ENTITIES_PER_FILE; entity += 1) {
    const index = fileIndex * ENTITIES_PER_FILE + entity;
    // Every entity points at the next, so resolution has real work to do and a
    // resolver that is quadratic in the entity count shows up immediately.
    const target = idFor((index + 1) % (FILES * ENTITIES_PER_FILE));
    text +=
      `<!-- mex:entity\nid: ${idFor(index)}\ntype: decision\nstatus: promoted\nrevision: 1\n` +
      `relations:\n  - type: depends_on\n    target: ${target}\n-->\n` +
      `## Entity ${String(index).padStart(4, "0")}\n\nProse for entity ${index}, with searchable words in it.\n\n`;
  }
  return text;
}

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");
  for (let file = 0; file < FILES; file += 1) scaffold.write(`notes/file-${String(file).padStart(3, "0")}.md`, fileText(file));
});

afterAll(() => {
  scaffold.dispose();
});

function millis(body: () => void): number {
  const started = performance.now();
  body();
  return performance.now() - started;
}

/**
 * The rebuild's own cost, so the refresh below can be judged against it.
 *
 * Set by the first test and read by the second. The refresh assertion used to
 * be an absolute 500 ms and it began failing under full-suite parallelism once
 * P5 added four more test files — passing in isolation, failing in the suite,
 * which is the worst kind of test to own. The threshold was **not** relaxed
 * (finding 29.10: scale with the corpus, never loosen). Instead the refresh is
 * measured against the rebuild *in the same run*, which is what the test
 * actually means: a refresh that reparsed all 100 files would land near the
 * rebuild's time. A ratio survives a loaded machine because both numbers
 * inflate together; the absolute bound is kept alongside it, generous enough
 * to catch a runaway and loose enough not to measure the CPU's mood.
 */
let rebuildMillis = 0;

describe("calibration (fails at 10x regression, not at target)", () => {
  it("rebuilds a tenth-scale scaffold well inside ten times the target", () => {
    const elapsed = millis(() => {
      const result = rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
      // Non-vacuity: a rebuild that indexed nothing would be very fast indeed.
      expect(result.entityCount).toBe(FILES * ENTITIES_PER_FILE);
    });
    // Target for 5,000 entities is 5 s; a tenth of the corpus at 10x is 5 s.
    expect(elapsed).toBeLessThan(5000);
    rebuildMillis = elapsed;
  });

  it("refreshes one file without reparsing the scaffold", () => {
    // Warm: the index already exists from the test above.
    const elapsed = millis(() => {
      const result = refreshWikiIndex({
        scaffoldRoot: scaffold.root,
        indexPath,
        changed: ["notes/file-042.md"],
        now: steppingClock(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.unchanged).toEqual(["notes/file-042.md"]);
    });
    // The property, stated as the ratio it is: parsing is the only thing a
    // refresh skips, so a refresh that reparsed the scaffold would land near
    // the rebuild. Half is already an order of magnitude worse than the ~2%
    // this actually costs, so a regression fails loudly while a busy machine
    // does not.
    expect(rebuildMillis).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(rebuildMillis * 0.5);
    // And an absolute ceiling, generous enough not to measure the CPU's mood.
    expect(elapsed).toBeLessThan(2000);
  });

  it("answers get, list, search and related inside ten times their targets", () => {
    const id = idFor(7);

    expect(
      millis(() => {
        const result = getEntity(indexPath, id);
        expect(result.ok).toBe(true);
      }),
    ).toBeLessThan(100); // target 10 ms

    expect(
      millis(() => {
        const result = listEntities(indexPath, { limit: 50 });
        expect(result.ok && result.value.items.length).toBe(50);
      }),
    ).toBeLessThan(500); // target 50 ms

    expect(
      millis(() => {
        const result = searchEntities(indexPath, "searchable", { limit: 50 });
        expect(result.ok && result.value.items.length).toBeGreaterThan(0);
      }),
    ).toBeLessThan(500);

    expect(
      millis(() => {
        const result = relatedEntities(indexPath, id, { depth: 2, limit: 50 });
        expect(result.ok && result.value.reached.length).toBeGreaterThan(0);
      }),
    ).toBeLessThan(500);
  });
});

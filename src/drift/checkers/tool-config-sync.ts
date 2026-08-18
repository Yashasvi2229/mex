import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftIssue } from "../../types.js";

/**
 * Files that `setup.sh` may copy with identical content from `.tool-configs/`.
 * If a user installs more than one tool and later edits one of these files in
 * place, the copies can silently drift out of sync. `.opencode/opencode.json`
 * is intentionally excluded -- it's a different format and references
 * `.mex/AGENTS.md` rather than embedding the same text.
 */
const TOOL_CONFIG_FILES: ReadonlyArray<string> = [
	"CLAUDE.md",
	"AGENTS.md",
	".cursorrules",
	".windsurfrules",
	".github/copilot-instructions.md",
];

/**
 * A file only participates in the sync check when it is actually a copy of the
 * mex tool config -- recognised by the sentinel comment every generated
 * template carries. Repos commonly have a hand-written CLAUDE.md or a
 * generated AGENTS.md that never came from `.tool-configs/`; those may still
 * mention ROUTER.md in ordinary guidance, so only the dedicated sentinel is
 * proof of scaffold origin.
 *
 * Anchored to the start of a line so a file that merely quotes the sentinel in
 * prose is not mistaken for a copy.
 */
const SCAFFOLD_MARKER = /^<!-- mex-tool-config\b/m;

/**
 * Copies installed before the sentinel shipped do not carry it, and nothing
 * rewrites them: `mex setup` skips any destination that already exists, so an
 * installed anchor is never re-copied. Without a second signal the check would
 * go silent for every pre-existing install -- real drift, no warning.
 *
 * This frontmatter line has been byte-stable across every tool config template
 * since the initial commit, so it identifies those copies with no migration
 * step. It is mex's own template prose and does not appear in an independently
 * owned config. Bridge only: drop it at a major version once installs have
 * turned over, leaving the sentinel as the sole contract.
 */
const LEGACY_MARKER = "Always-loaded project anchor. Read this first.";

/** Whether a file is a copy of the mex tool config, new sentinel or legacy. */
function isScaffoldCopy(content: string): boolean {
	return SCAFFOLD_MARKER.test(content) || content.includes(LEGACY_MARKER);
}

/** One copy differs from what the others agree on. */
function drift(path: string, reference: string): DriftIssue {
	return {
		code: "TOOL_CONFIG_DRIFT",
		severity: "warning",
		file: path,
		line: null,
		message: `Tool config ${path} has drifted from ${reference}. Re-copy from .tool-configs/ or edit both to match.`,
	};
}

/** Check that all installed tool config files hold identical content. */
export function checkToolConfigSync(projectRoot: string): DriftIssue[] {
	const present: Array<{ path: string; content: string }> = [];
	for (const rel of TOOL_CONFIG_FILES) {
		const abs = resolve(projectRoot, rel);
		if (!existsSync(abs)) continue;
		try {
			const content = readFileSync(abs, "utf-8");
			if (!isScaffoldCopy(content)) continue;
			present.push({ path: rel, content });
		} catch {
			// Unreadable file -- ignore rather than reporting a checker-internal error.
		}
	}

	// Nothing to compare until at least two tool configs are installed.
	if (present.length < 2) return [];

	// Group the copies by content, keeping TOOL_CONFIG_FILES order within and
	// between groups. Identical copies collapse into one group; each edit that
	// was not propagated forms another.
	const groups = new Map<string, string[]>();
	for (const { path, content } of present) {
		const group = groups.get(content);
		if (group) group.push(path);
		else groups.set(content, [path]);
	}
	if (groups.size === 1) return [];

	const ordered = [...groups.values()];

	// With exactly two copies there is no majority to appeal to and no way to
	// tell which one moved, so keep reporting the pair as before.
	if (present.length === 2) {
		return [drift(present[1].path, present[0].path)];
	}

	// The largest group is what the copies are supposed to say: an edit made in
	// one place leaves the others agreeing. Blaming the first file in list order
	// instead pins every warning on the wrong file whenever the edited copy
	// happens to sort first. See https://github.com/mex-memory/mex/issues/127
	const largest = ordered.reduce((a, b) => (b.length > a.length ? b : a));
	const tied = ordered.filter((g) => g.length === largest.length).length > 1;

	// No majority means no honest culprit -- say they diverged and stop there,
	// rather than picking a group to blame.
	if (tied) {
		const summary = ordered.map((g) => `[${g.join(", ")}]`).join(" vs ");
		return [
			{
				code: "TOOL_CONFIG_DRIFT",
				severity: "warning",
				file: ordered[0][0],
				line: null,
				message: `Tool configs have diverged into ${ordered.length} groups with no majority: ${summary}. Decide which is correct and re-copy it over the others.`,
			},
		];
	}

	const issues: DriftIssue[] = [];
	for (const group of ordered) {
		if (group === largest) continue;
		for (const path of group) {
			issues.push(drift(path, largest[0]));
		}
	}
	return issues;
}

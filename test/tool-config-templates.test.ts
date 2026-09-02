import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";
import { extractFrontmatter, findMexAnchors } from "../src/markdown.js";
import {
  MEX_INSTRUCTIONS_END,
  MEX_INSTRUCTIONS_START,
  renderManagedInstructionBlock,
} from "../src/agent-skills/instructions.js";

const roots: string[] = [];
const unsupportedEmbedded = [".cursorrules", ".windsurfrules", "copilot-instructions.md"];
const capabilityGuidance = [
  "mex capabilities --json",
  "smallest relevant structured resolver",
  "mex inbox contract --action <command-id> --json",
  "mex relay contract --action <command-id> --json",
  "explicitly asks to create, save, or draft a checkout-local Inbox or Relay draft",
  "preview and apply that exact draft without asking for redundant confirmation",
  "publishing, approving, rejecting, withdrawing, marking stale, repairing, taking or acknowledging, or closing",
  "requires fresh explicit confirmation after semantic preview",
  "Git commit, push, and pull as separate actions requiring their own authorization",
];

const supersededBlanketApprovalGuidance =
  "wait for explicit human approval before running an apply command";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shipped code-graph agent guidance", () => {
  it("models grounding slots and inert inline-anchor examples in templates and dogfood", () => {
    for (const area of ["templates", ".mex"]) {
      for (const name of ["architecture", "conventions", "decisions", "setup", "stack"]) {
        const content = readFileSync(join(area, "context", `${name}.md`), "utf-8");
        expect(extractFrontmatter(content)?.grounds_to, `${area}/${name}`).toEqual([]);
        expect(content, `${area}/${name}`).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
        expect(findMexAnchors(content), `${area}/${name} examples must stay inert`).toEqual([]);
      }
      const patterns = readFileSync(join(area, "patterns/README.md"), "utf-8");
      expect(patterns).toContain("grounds_to:");
      expect(patterns).toContain('fingerprint: "mh:64:<hex-fingerprint>"');
      expect(patterns).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
      expect(findMexAnchors(patterns), `${area}/patterns examples must stay inert`).toEqual([]);
    }
  });

  it("keeps common guidance aligned without promising skills to unsupported clients", () => {
    const unsupported = unsupportedEmbedded.map((name) => (
      readFileSync(join("templates/.tool-configs", name), "utf-8")
    ));
    expect(new Set(unsupported).size).toBe(1);
    for (const content of unsupported) {
      expect(content).toContain("mex impact <symbol|file>");
      expect(content).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
      expect(content).toContain("adjudicate any AMBIGUOUS grounding");
      expect(content).toContain("refreshed grounding is re-emitted");
      for (const guidance of capabilityGuidance) expect(content).toContain(guidance);
      expect(content).not.toContain(MEX_INSTRUCTIONS_START);
      expect(content).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
      expect(content).not.toContain(supersededBlanketApprovalGuidance);
    }

    const claude = readFileSync("templates/.tool-configs/CLAUDE.md", "utf-8");
    expect(claude).toContain(renderManagedInstructionBlock("claude"));
    expect(claude).toContain("/mex-inbox");
    expect(claude).not.toContain("$mex-inbox");
    expect(claude).not.toContain(supersededBlanketApprovalGuidance);
  });

  it("keeps maintained equivalents aligned and OpenCode delegated to guided AGENTS.md", () => {
    const maintainedUnsupported = unsupportedEmbedded.map((name) => (
      readFileSync(join(".mex/.tool-configs", name), "utf-8")
    ));
    expect(new Set(maintainedUnsupported).size).toBe(1);
    expect(maintainedUnsupported[0]).toContain("mex impact <symbol|file>");
    expect(readFileSync(".mex/.tool-configs/CLAUDE.md", "utf-8"))
      .toContain(renderManagedInstructionBlock("claude"));
    const agents = readFileSync("templates/AGENTS.md", "utf-8");
    expect(agents).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    expect(agents).toContain(MEX_INSTRUCTIONS_START);
    expect(agents).toContain("MEX context used: <specific records/files/entities consulted>.");
    expect(agents).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    for (const guidance of capabilityGuidance) expect(agents).toContain(guidance);
    expect(agents).not.toContain(supersededBlanketApprovalGuidance);
    const agentMemory = readFileSync("templates/agent-memory/AGENTS.md", "utf-8");
    for (const guidance of capabilityGuidance) expect(agentMemory).toContain(guidance);
    expect(agentMemory).not.toContain(supersededBlanketApprovalGuidance);
    expect(agentMemory).toContain(MEX_INSTRUCTIONS_START);
    expect(agentMemory).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    const maintainedAgents = readFileSync(".mex/AGENTS.md", "utf-8");
    for (const guidance of capabilityGuidance) expect(maintainedAgents).toContain(guidance);
    expect(maintainedAgents).not.toContain(supersededBlanketApprovalGuidance);
    expect(maintainedAgents).toContain(MEX_INSTRUCTIONS_START);
    expect(maintainedAgents).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    for (const guidance of capabilityGuidance) expect(maintainedUnsupported[0]).toContain(guidance);
    for (const file of ["templates/.tool-configs/opencode.json", ".mex/.tool-configs/opencode.json"]) {
      expect(JSON.parse(readFileSync(file, "utf-8")).instructions).toContain(".mex/AGENTS.md");
    }
  });

  it("keeps root dogfood instructions minimal and client-specific", () => {
    expect(readFileSync("CLAUDE.md", "utf-8"))
      .toBe(`${renderManagedInstructionBlock("claude")}\n`);
    expect(readFileSync("AGENTS.md", "utf-8"))
      .toBe(`${renderManagedInstructionBlock("codex")}\n`);
  });

  it("passes tool-config-sync after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-tool-configs-"));
    roots.push(root);
    writeFileSync(join(root, "CLAUDE.md"), `${renderManagedInstructionBlock("claude")}\n`);
    writeFileSync(join(root, "AGENTS.md"), `${renderManagedInstructionBlock("codex")}\n`);
    const content = readFileSync("templates/.tool-configs/.cursorrules", "utf-8");
    for (const path of [".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    expect(checkToolConfigSync(root)).toEqual([]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf-8")).toContain(MEX_INSTRUCTIONS_END);
  });
});

/**
 * One benchmark identity for every route registered by Hub AppRoutes.
 *
 * Several routes intentionally share one lazy module. They still receive
 * separate measurements and budgets: this is a per-route contract, not a
 * per-chunk inventory.
 */
export const RELEASE_ROUTE_MANIFEST_HINTS = Object.freeze({
  home: Object.freeze(["HomePage"]),
  search: Object.freeze(["SearchPage"]),
  knowledge: Object.freeze(["KnowledgePage"]),
  knowledgeDetail: Object.freeze(["KnowledgePage"]),
  code: Object.freeze(["SearchPage"]),
  codeSymbol: Object.freeze(["SymbolPage"]),
  workstreams: Object.freeze(["CapabilityPage"]),
  specs: Object.freeze(["CapabilityPage"]),
  playbooks: Object.freeze(["CapabilityPage"]),
  inbox: Object.freeze(["CapabilityPage"]),
  relays: Object.freeze(["CapabilityPage"]),
  members: Object.freeze(["MembersPage"]),
  activity: Object.freeze(["ActivityPage"]),
  jobs: Object.freeze(["JobsPage"]),
  health: Object.freeze(["HealthPage"]),
  notFound: Object.freeze(["CapabilityPage"]),
});

export const RELEASE_ROUTE_KEYS = Object.freeze(Object.keys(RELEASE_ROUTE_MANIFEST_HINTS));
export const RELEASE_ROUTE_PATTERNS = Object.freeze({
  home: "(index)",
  search: "search",
  knowledge: "knowledge",
  knowledgeDetail: "knowledge/:id",
  code: "code",
  codeSymbol: "code/symbols/:id",
  workstreams: "workstreams",
  specs: "specs",
  playbooks: "playbooks",
  inbox: "inbox",
  relays: "relays",
  members: "members",
  activity: "activity",
  jobs: "jobs",
  health: "health",
  notFound: "*",
});

export function releaseWorkbenchPaths({ knowledgeEntityId, codeSymbolId }) {
  const knowledgeId = boundedIdentifier(knowledgeEntityId, "Knowledge entity");
  const symbolId = boundedIdentifier(codeSymbolId, "Code symbol");
  return {
    home: "/",
    search: "/search?q=releaseBenchmarkNeedle",
    knowledge: "/knowledge",
    knowledgeDetail: `/knowledge/${encodeURIComponent(knowledgeId)}`,
    code: "/code?q=releaseBenchmarkNeedle",
    codeSymbol: `/code/symbols/${encodeURIComponent(symbolId)}`,
    workstreams: "/workstreams",
    specs: "/specs",
    playbooks: "/playbooks",
    inbox: "/inbox",
    relays: "/relays",
    members: "/members",
    activity: "/activity",
    jobs: "/jobs",
    health: "/health",
    notFound: "/release-benchmark-not-found",
  };
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} ID must contain between 1 and 512 characters.`);
  }
  return value;
}

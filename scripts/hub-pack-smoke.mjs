import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("The packed Hub smoke must run through npm so its CLI entry is known.");
}
const work = mkdtempSync(join(tmpdir(), "mex-hub-pack-smoke-"));
const npmCache = join(work, "npm-cache");
mkdirSync(npmCache, { recursive: true });
let child;

try {
  const packed = runNpm([
    "pack",
    "--silent",
    "--cache",
    npmCache,
    "--pack-destination",
    work,
  ], root)
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (!packed) throw new Error("npm pack did not report a tarball.");
  const tarball = join(work, basename(packed));
  const project = join(work, "project");
  mkdirSync(join(project, ".mex"), { recursive: true });
  writeFileSync(join(project, "package.json"), "{\n  \"private\": true\n}\n");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n.mex/graph.db*\n.mex/local/\n");
  writeFileSync(join(project, ".mex", "ROUTER.md"), "# Project Router\n");
  writeFileSync(
    join(project, ".mex", "config.json"),
    JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "packed-hub-smoke",
      wiki: {
        exclude: ["excluded/**"],
        readOnly: ["context/read-only/**"],
      },
    }, null, 2) + "\n",
  );
  writeActivityFixture(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "packed.ts"), [
    "export function packedService(input: number): number {",
    "  return input * 2;",
    "}",
    "",
    "export function packedCaller(): number {",
    "  return packedService(21);",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Packed Ada"], project);
  run("git", ["config", "user.email", "packed@example.test"], project);
  run("git", ["add", ".gitignore", "package.json", ".mex", "src"], project);
  run("git", ["commit", "--quiet", "-m", "test fixture"], project);
  runNpm([
    "install",
    tarball,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--cache",
    npmCache,
  ], project);

  const installed = join(project, "node_modules", "mex-agent");
  const manifest = join(installed, "dist", "hub", ".vite", "manifest.json");
  if (!existsSync(manifest)) throw new Error("The packed package omitted dist/hub assets.");
  const declaration = readFileSync(join(installed, "dist", "index.d.ts"), "utf8");
  if (
    /Hub(?:Job|Api|Session|Capabilities|Activity|Wiki)|Activity(?:Request|Response|Item|Diagnostic)|CodeWorkspace|CodeKnowledge(?:Request|Response)|GraphHealthDetails|WikiHealthDetails|WikiEntity(?:List|Detail)(?:Request|Response)|Wiki(?:Relations|Backlinks)(?:Request|Response)|WikiSearchResult|RepositoryGraphPort|RepositoryWiki|createRepositoryWikiPort|runHubCommand|TeamRelay|RelayHandoff/.test(
      declaration,
    )
  ) {
    throw new Error("Private Hub or Relay declarations leaked through the package root.");
  }

  const cli = join(installed, "dist", "cli.js");
  const relayContractOutput = run(
    process.execPath,
    [cli, "relay", "contract", "--json"],
    work,
  );
  if (Buffer.byteLength(relayContractOutput, "utf8") > 65_536) {
    throw new Error("The packed Relay resolver exceeded its 64 KiB output ceiling.");
  }
  const relayContract = JSON.parse(relayContractOutput);
  if (
    relayContract?.command !== "relay.contract"
    || relayContract?.ok !== true
    || relayContract?.data?.requestFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-request-v1.json"
    || relayContract?.data?.applyFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-preview-envelope-v1.json"
  ) {
    throw new Error("The packed install omitted the static Relay command contract.");
  }
  run(process.execPath, [cli, "graph", "rebuild", "--root", project, "--json"], project);
  const graphScope = run(process.execPath, [
    cli,
    "graph",
    "scope",
    "packedService",
    "--detail",
    "minimal",
    "--fingerprint",
    "--max-nodes",
    "10",
    "--max-files",
    "1",
    "--max-output-tokens",
    "2000",
  ], project).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const groundedFact = graphScope.find((record) => (
    record.type === "fact" && record.name === "packedService"
  ));
  if (
    typeof groundedFact?.id !== "string"
    || typeof groundedFact.fingerprint !== "string"
    || typeof groundedFact.bodyHash !== "string"
  ) {
    throw new Error("The packed graph did not expose exact grounding facts for the Wiki fixture.");
  }
  writeWikiFixture(project, {
    nodeId: groundedFact.id,
    fingerprint: groundedFact.fingerprint,
    bodyHash: groundedFact.bodyHash,
  });
  run("git", ["add", ".mex/context", ".mex/excluded", ".mex/topics"], project);
  run("git", ["commit", "--quiet", "-m", "add packed wiki fixture"], project);
  run(process.execPath, [cli, "graph", "rebuild", "--root", project, "--json"], project);
  run(process.execPath, [cli, "wiki", "rebuild-index", "--json"], project);
  child = spawn(process.execPath, [cli, "hub", "--no-open"], {
    cwd: project,
    env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bootstrapUrl = await readBootstrapUrl(child);
  const url = new URL(bootstrapUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("The packaged Hub did not emit a bootstrap token.");
  const beforeReads = snapshotProtectedProjectState(project);

  const html = await fetch(`${url.origin}/`, { redirect: "error" });
  if (!html.ok || !(await html.text()).includes("<div id=\"root\"></div>")) {
    throw new Error("The packaged Hub did not serve its application shell.");
  }
  const bootstrap = await fetch(`${url.origin}/api/v1/session/bootstrap`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      origin: url.origin,
    },
    body: JSON.stringify({ token }),
  });
  if (bootstrap.status !== 201) {
    throw new Error(`Hub bootstrap failed with HTTP ${bootstrap.status}.`);
  }
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Hub bootstrap did not set a session cookie.");
  const session = await fetch(`${url.origin}/api/v1/session`, {
    headers: { cookie },
    redirect: "error",
  });
  const sessionBody = await session.json();
  if (!session.ok || typeof sessionBody.csrfToken !== "string") {
    throw new Error("The packaged Hub session API did not load.");
  }
  const capabilities = await fetch(`${url.origin}/api/v1/capabilities`, {
    headers: { cookie },
    redirect: "error",
  });
  const capabilitiesBody = await capabilities.json();
  if (
    !capabilities.ok
    || capabilitiesBody.apiVersion !== "v1"
    || capabilitiesBody.graph?.read?.availability !== "available"
    || capabilitiesBody.graph?.refresh?.availability !== "available"
    || capabilitiesBody.graph?.rebuild?.availability !== "available"
    || capabilitiesBody.wiki?.read?.availability !== "available"
    || capabilitiesBody.wiki?.refresh?.availability !== "available"
    || capabilitiesBody.wiki?.rebuild?.availability !== "available"
  ) {
    throw new Error("The packaged Hub capabilities API did not load.");
  }
  const home = await fetch(`${url.origin}/api/v1/home`, {
    headers: { cookie },
    redirect: "error",
  });
  const homeBody = await home.json();
  const activity = await fetch(`${url.origin}/api/v1/activity`, {
    headers: { cookie },
    redirect: "error",
  });
  const activityBody = await activity.json();
  if (!home.ok || homeBody.sections?.activity?.count !== 1) {
    const diagnosticCodes = Array.isArray(activityBody?.diagnostics)
      ? activityBody.diagnostics.slice(0, 10).map((item) => ({
          code: typeof item?.code === "string" ? item.code : "UNKNOWN",
          severity: typeof item?.severity === "string" ? item.severity : "unknown",
        }))
      : null;
    const detail = JSON.stringify({
      homeStatus: home.status,
      homeProblemCode: typeof homeBody?.code === "string" ? homeBody.code : null,
      homeActivity: homeBody.sections?.activity ?? null,
      activityStatus: activity.status,
      canonicalActivityCount: Array.isArray(activityBody?.items)
        ? activityBody.items.filter((item) => item?.source === "activity").length
        : null,
      fixtureHasCarriageReturn: readFileSync(
        join(
          project,
          ".mex",
          "events",
          "activity",
          "2026-08",
          "event_01K3Q080000000000000000001.md",
        ),
      ).includes(13),
      diagnosticCodes,
    });
    throw new Error(`The packaged Hub did not report the exact canonical activity count: ${detail}`);
  }
  if (
    !activity.ok
    || activityBody.items?.length !== 2
    || !activityBody.items.some((item) => item.source === "activity" && item.action === "activity.packed")
    || !activityBody.items.some((item) => item.source === "legacy" && item.message === "Packed legacy decision")
  ) {
    throw new Error("The packaged Hub did not project real canonical and legacy activity.");
  }
  const serializedActivity = JSON.stringify(activityBody);
  for (const secret of [
    "fixture must stay private",
    "/Users/alice/private-project",
    ".mex/traces/private.md",
    "private-agent",
    "private-status",
    "../outside.ts",
  ]) {
    if (serializedActivity.includes(secret)) {
      throw new Error(`The packaged activity API leaked a private field: ${secret}`);
    }
  }
  const search = await fetch(`${url.origin}/api/v1/search?q=packedService&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const searchBody = await search.json();
  const symbol = searchBody.groups?.symbols?.items?.find((item) => (
    item.kind === "code_symbol" && item.name === "packedService"
  ));
  if (
    !search.ok
    || searchBody.groups?.symbols?.status !== "available"
    || searchBody.groups?.sources?.status !== "available"
    || !symbol
  ) {
    throw new Error("The packaged Hub did not expose real grouped graph search.");
  }
  const code = await fetch(
    `${url.origin}/api/v1/code/symbols/${encodeURIComponent(symbol.id)}?view=callers`,
    { headers: { cookie }, redirect: "error" },
  );
  const codeBody = await code.json();
  if (
    !code.ok
    || codeBody.symbol?.id !== symbol.id
    || !codeBody.source?.items?.some((item) => item.content.includes("packedService"))
    || codeBody.traversal?.view !== "callers"
  ) {
    throw new Error("The packaged Hub did not expose the real symbol workspace.");
  }
  const wikiSearch = await fetch(`${url.origin}/api/v1/search?q=packed&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const wikiSearchBody = await wikiSearch.json();
  const wikiHit = wikiSearchBody.groups?.wiki?.items?.find((item) => (
    item.kind === "wiki" && item.title === "Preserve packed retries"
  ));
  if (!wikiSearch.ok || wikiSearchBody.groups?.wiki?.status !== "available" || !wikiHit) {
    throw new Error("The packaged Hub did not expose real Wiki search.");
  }
  const excludedSearch = await fetch(`${url.origin}/api/v1/search?q=excluded-only-sentinel&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const excludedSearchBody = await excludedSearch.json();
  if (
    !excludedSearch.ok
    || excludedSearchBody.groups?.wiki?.status !== "available"
    || excludedSearchBody.groups.wiki.items?.length !== 0
  ) {
    throw new Error("The packaged Hub ignored the configured Wiki exclusion during search.");
  }
  const completeKnowledgeList = await fetch(`${url.origin}/api/v1/wiki/entities?limit=50`, {
    headers: { cookie },
    redirect: "error",
  });
  const completeKnowledgeListBody = await completeKnowledgeList.json();
  if (
    !completeKnowledgeList.ok
    || completeKnowledgeListBody.items?.some((item) => item.id === "mx_01J00000000000000000000004")
  ) {
    throw new Error("The packaged Hub indexed a Wiki entity excluded by project configuration.");
  }
  const knowledgeList = await fetch(
    `${url.origin}/api/v1/wiki/entities?kind=decision&sourceType=symbol`,
    { headers: { cookie }, redirect: "error" },
  );
  const knowledgeListBody = await knowledgeList.json();
  if (
    !knowledgeList.ok
    || knowledgeListBody.items?.length !== 1
    || knowledgeListBody.items[0]?.id !== wikiHit.id
    || knowledgeListBody.items[0]?.groundingHealth !== "fresh"
  ) {
    throw new Error("The packaged Hub did not list real filtered Knowledge.");
  }
  const knowledge = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}`,
    { headers: { cookie }, redirect: "error" },
  );
  const knowledgeBody = await knowledge.json();
  if (
    !knowledge.ok
    || knowledgeBody.entity?.id !== wikiHit.id
    || !knowledgeBody.body?.content?.includes("original stable request key")
    || knowledgeBody.relationCount !== 1
    || knowledgeBody.backlinkCount !== 1
    || knowledgeBody.groundings?.items?.[0]?.requestedNode !== symbol.id
  ) {
    throw new Error("The packaged Hub did not expose a bounded real Knowledge detail.");
  }
  const relations = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}/relations?direction=both`,
    { headers: { cookie }, redirect: "error" },
  );
  const relationsBody = await relations.json();
  if (
    !relations.ok
    || !relationsBody.items?.some((item) => item.direction === "outgoing" && item.relation?.type === "implements")
    || !relationsBody.items?.some((item) => item.direction === "incoming" && item.relation?.type === "depends_on")
  ) {
    throw new Error("The packaged Hub did not expose real Knowledge relations.");
  }
  const backlinks = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}/backlinks?type=depends_on`,
    { headers: { cookie }, redirect: "error" },
  );
  const backlinksBody = await backlinks.json();
  if (!backlinks.ok || backlinksBody.items?.length !== 1 || backlinksBody.items[0]?.type !== "depends_on") {
    throw new Error("The packaged Hub did not expose real Knowledge backlinks.");
  }
  const codeKnowledge = await fetch(
    `${url.origin}/api/v1/code/symbols/${encodeURIComponent(symbol.id)}/knowledge`,
    { headers: { cookie }, redirect: "error" },
  );
  const codeKnowledgeBody = await codeKnowledge.json();
  if (
    !codeKnowledge.ok
    || codeKnowledgeBody.items?.length !== 1
    || codeKnowledgeBody.items[0]?.entity?.id !== wikiHit.id
    || codeKnowledgeBody.items[0]?.matchedNodes?.[0] !== symbol.id
  ) {
    throw new Error("The packaged Hub did not expose explicit Code-to-Knowledge links.");
  }
  const serializedKnowledge = JSON.stringify({
    wikiSearchBody,
    knowledgeListBody,
    knowledgeBody,
    relationsBody,
    backlinksBody,
    codeKnowledgeBody,
    excludedSearchBody,
    completeKnowledgeListBody,
  });
  for (const secret of [
    project,
    "packed-private-session",
    "packed-topic-private-metadata",
    "packed-source-private-metadata",
    "packed-entity-private-metadata",
    "excluded-only-private-body",
  ]) {
    if (serializedKnowledge.includes(secret)) {
      throw new Error(`The packaged Knowledge API leaked a private field: ${secret}`);
    }
  }
  const health = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const healthBody = await health.json();
  const graphHealth = healthBody.components?.find((component) => component.id === "graph");
  const wikiHealth = healthBody.components?.find((component) => component.id === "wiki");
  if (
    !health.ok
    || graphHealth?.graph?.indexStatus !== "fresh"
    || wikiHealth?.wiki?.indexStatus !== "fresh"
    || JSON.stringify(wikiHealth.wiki.allowedJobKinds) !== JSON.stringify(["wiki_refresh", "wiki_rebuild"])
    || wikiHealth.wiki.recommendedJobKind !== null
  ) {
    throw new Error("The packaged Hub did not report fresh graph and Wiki health.");
  }
  const afterReads = snapshotProtectedProjectState(project);
  if (JSON.stringify(afterReads) !== JSON.stringify(beforeReads)) {
    throw new Error("Reading packaged Home, Activity, Search, Code, Knowledge, or Health mutated protected project state.");
  }

  const beforeMaintenance = snapshotProtectedProjectState(project, { includeRuntimeState: false });

  for (const kind of ["graph_refresh", "graph_rebuild"]) {
    if (kind === "graph_rebuild") {
      writeFileSync(join(project, ".mex", "graph.db"), "intentionally corrupt graph for rebuild coverage\n");
      const corruptHealth = await fetch(`${url.origin}/api/v1/health`, {
        headers: { cookie },
        redirect: "error",
      });
      const corruptHealthBody = await corruptHealth.json();
      const corruptGraph = corruptHealthBody.components?.find((component) => component.id === "graph");
      if (!corruptHealth.ok || corruptGraph?.graph?.indexStatus !== "corrupt") {
        throw new Error("The packaged Hub did not observe the intentionally corrupt graph before rebuild.");
      }
    }
    const started = await fetch(`${url.origin}/api/v1/jobs`, {
      method: "POST",
      headers: {
        cookie,
        origin: url.origin,
        "content-type": "application/json",
        "x-mex-csrf": sessionBody.csrfToken,
      },
      body: JSON.stringify({ kind }),
      redirect: "error",
    });
    const startedBody = await started.json();
    if (started.status !== 202 || typeof startedBody.id !== "string") {
      throw new Error(`The packaged Hub could not start ${kind}.`);
    }
    const terminal = await waitForJob(url.origin, cookie, startedBody.id);
    if (terminal.state !== "succeeded") {
      throw new Error(`The packaged Hub ${kind} job did not succeed.`);
    }
  }
  const repairedHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const repairedHealthBody = await repairedHealth.json();
  const repairedGraph = repairedHealthBody.components?.find((component) => component.id === "graph");
  if (!repairedHealth.ok || repairedGraph?.graph?.indexStatus !== "fresh") {
    throw new Error("The packaged Hub graph rebuild did not replace the corrupt graph with a fresh index.");
  }
  const afterMaintenance = snapshotProtectedProjectState(project, { includeRuntimeState: false });
  if (JSON.stringify(afterMaintenance) !== JSON.stringify(beforeMaintenance)) {
    throw new Error("Packaged graph maintenance mutated source, Git, activity, member, or Wiki state.");
  }

  const wikiSource = join(project, ".mex", "context", "packed-knowledge.md");
  writeFileSync(
    wikiSource,
    readFileSync(wikiSource, "utf8").replace(
      "The packed service retries only with the original stable request key.",
      "The packed service retries transient failures with the original stable request key.",
    ),
  );
  const staleWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const staleWikiHealthBody = await staleWikiHealth.json();
  const staleWiki = staleWikiHealthBody.components?.find((component) => component.id === "wiki");
  if (
    !staleWikiHealth.ok
    || staleWiki?.wiki?.indexStatus !== "stale"
    || staleWiki?.wiki?.recommendedJobKind !== "wiki_refresh"
  ) {
    throw new Error("The packaged Hub did not recommend explicit Wiki refresh for stale canonical Markdown.");
  }
  const beforeWikiMaintenance = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
    includeGraphIndex: true,
    includeWikiIndex: false,
  });
  const wikiRefresh = await startJob(
    url.origin,
    cookie,
    sessionBody.csrfToken,
    "wiki_refresh",
    [project],
  );
  if (wikiRefresh.state !== "succeeded") {
    throw new Error("The packaged Hub wiki_refresh job did not succeed.");
  }
  const refreshedWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const refreshedWikiBody = await refreshedWikiHealth.json();
  if (
    !refreshedWikiHealth.ok
    || refreshedWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "fresh"
  ) {
    throw new Error("The packaged Hub did not report fresh Wiki health after refresh.");
  }

  writeFileSync(join(project, ".mex", "wiki.db"), "intentionally corrupt Wiki index for rebuild coverage\n");
  const corruptWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const corruptWikiBody = await corruptWikiHealth.json();
  if (
    !corruptWikiHealth.ok
    || corruptWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "corrupt"
  ) {
    throw new Error("The packaged Hub did not observe the intentionally corrupt Wiki index before rebuild.");
  }
  const wikiRebuild = await startJob(
    url.origin,
    cookie,
    sessionBody.csrfToken,
    "wiki_rebuild",
    [project],
  );
  if (wikiRebuild.state !== "succeeded") {
    throw new Error("The packaged Hub wiki_rebuild job did not succeed.");
  }
  const repairedWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const repairedWikiBody = await repairedWikiHealth.json();
  if (
    !repairedWikiHealth.ok
    || repairedWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "fresh"
  ) {
    throw new Error("The packaged Hub Wiki rebuild did not publish a fresh replacement index.");
  }
  const afterWikiMaintenance = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
    includeGraphIndex: true,
    includeWikiIndex: false,
  });
  if (JSON.stringify(afterWikiMaintenance) !== JSON.stringify(beforeWikiMaintenance)) {
    throw new Error("Packaged Wiki maintenance mutated canonical Wiki, Graph, Activity, members, source, or Git state.");
  }

  child.kill("SIGTERM");
  const exit = await waitForExit(child, 8_000);
  child = undefined;
  const stoppedAsRequested = exit.code === 0 && exit.signal === null;
  const terminatedAsRequestedOnWindows = process.platform === "win32"
    && exit.code === null
    && exit.signal === "SIGTERM";
  if (!stoppedAsRequested && !terminatedAsRequestedOnWindows) {
    throw new Error(`The packaged Hub did not stop cleanly (${JSON.stringify(exit)}).`);
  }
  process.stdout.write("Packed Project Hub smoke test passed.\n");
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}

function writeActivityFixture(project) {
  const eventId = "event_01K3Q080000000000000000001";
  const activityRoot = join(project, ".mex", "events", "activity", "2026-08");
  mkdirSync(activityRoot, { recursive: true });
  writeFileSync(join(activityRoot, `${eventId}.md`), [
    "---",
    "schema_version: 1",
    `id: ${JSON.stringify(eventId)}`,
    "timestamp: \"2026-08-23T01:02:03.000Z\"",
    "actor: {\"email\":\"packed@example.test\",\"kind\":\"git\",\"name\":\"Packed Ada\"}",
    "action: \"activity.packed\"",
    "subjects: [{\"kind\":\"file\",\"path\":\"src/packed.ts\"},{\"hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"kind\":\"commit\"}]",
    "repo_state: {\"branch\":\"main\",\"dirty\":false,\"head\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"observedAt\":\"2026-08-23T01:02:02.000Z\"}",
    "metadata: {\"internal_note\":\"fixture must stay private\"}",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".mex", "events", "decisions.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-22T01:02:03.000Z",
    kind: "decision",
    message: "Packed legacy decision",
    files: ["src/packed.ts", "../outside.ts"],
    cwd: "/Users/alice/private-project",
    trace: ".mex/traces/private.md",
    source: "private-agent",
    status: "private-status",
  })}\n`);
}

function writeWikiFixture(project, grounding) {
  const topicId = "mx_01J00000000000000000000001";
  const decisionId = "mx_01J00000000000000000000002";
  const patternId = "mx_01J00000000000000000000003";
  const topics = join(project, ".mex", "topics");
  const context = join(project, ".mex", "context");
  const excluded = join(project, ".mex", "excluded");
  mkdirSync(topics, { recursive: true });
  mkdirSync(context, { recursive: true });
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(topics, "payments.md"), [
    "<!-- mex:entity",
    `id: ${topicId}`,
    "type: topic",
    "status: promoted",
    "revision: 1",
    "summary: Reliable payment processing knowledge.",
    "metadata:",
    "  aliases: [payments, checkout]",
    "  private_note: packed-topic-private-metadata",
    "-->",
    "## Payments",
    "",
    "Payment processing must remain recoverable and idempotent.",
    "",
  ].join("\n"));
  writeFileSync(join(context, "packed-knowledge.md"), [
    "<!-- mex:entity",
    `id: ${decisionId}`,
    "type: decision",
    "status: promoted",
    "revision: 2",
    "summary: Retry packed service calls with the original request key.",
    `topics: [${topicId}]`,
    "relations:",
    "  - type: implements",
    `    target: ${patternId}`,
    "sources:",
    "  - type: symbol",
    `    ref: ${JSON.stringify(grounding.nodeId)}`,
    "    note: Exact packed service declaration.",
    "    metadata:",
    "      private_source_note: packed-source-private-metadata",
    "grounds_to:",
    `  - node: ${JSON.stringify(grounding.nodeId)}`,
    `    fingerprint: ${JSON.stringify(grounding.fingerprint)}`,
    `    bodyHash: ${JSON.stringify(grounding.bodyHash)}`,
    "    reason: Exact packed service grounding.",
    "provenance:",
    "  createdBy: { kind: agent, id: packed-fixture-agent }",
    "  createdAt: 2026-08-23T00:00:00.000Z",
    "  agentSessionId: packed-private-session",
    "metadata:",
    "  private_note: packed-entity-private-metadata",
    "-->",
    "## Preserve packed retries",
    "",
    "The packed service retries only with the original stable request key.",
    "",
    "<!-- mex:entity",
    `id: ${patternId}`,
    "type: pattern",
    "status: in_flight",
    "revision: 1",
    "summary: Wrap packed calls in a bounded retry envelope.",
    `topics: [${topicId}]`,
    "relations:",
    "  - type: depends_on",
    `    target: ${decisionId}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Packed retry envelope",
    "",
    "Retry transient failures without duplicating the underlying operation.",
    "",
  ].join("\n"));
  writeFileSync(join(excluded, "private.md"), [
    "<!-- mex:entity",
    "id: mx_01J00000000000000000000004",
    "type: fact",
    "status: promoted",
    "revision: 1",
    "summary: excluded-only-sentinel",
    "-->",
    "## Configured exclusion",
    "",
    "excluded-only-private-body",
    "",
  ].join("\n"));
}

function snapshotProtectedProjectState(
  project,
  {
    includeRuntimeState = true,
    includeGraphIndex = includeRuntimeState,
    includeWikiIndex = true,
  } = {},
) {
  const status = run("git", [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ], project);
  const candidates = [
    join(project, ".mex", "events"),
    join(project, ".mex", "team"),
    join(project, ".mex", "context"),
    join(project, ".mex", "excluded"),
    join(project, ".mex", "topics"),
    join(project, ".mex", "ROUTER.md"),
    join(project, ".mex", "config.json"),
    join(project, "src"),
  ];
  if (includeRuntimeState) {
    const localRoot = join(project, ".mex", "local");
    if (existsSync(localRoot)) {
      for (const name of readdirSync(localRoot)) {
        if (name.startsWith("team.db")) candidates.push(join(localRoot, name));
      }
    }
  }
  for (const name of readdirSync(join(project, ".mex"))) {
    if (
      (includeWikiIndex && name.startsWith("wiki.db"))
      || (includeGraphIndex && name.startsWith("graph.db"))
    ) {
      candidates.push(join(project, ".mex", name));
    }
  }
  candidates.push(
    join(project, ".git", "HEAD"),
    join(project, ".git", "index"),
    join(project, ".git", "refs", "heads"),
  );

  const files = [];
  for (const candidate of candidates) collectSnapshotFiles(project, candidate, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    files,
    status,
  };
}

function collectSnapshotFiles(project, path, files) {
  if (!existsSync(path)) return;
  const stats = statSync(path, { bigint: true });
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) collectSnapshotFiles(project, join(path, name), files);
    return;
  }
  if (!stats.isFile()) return;
  files.push({
    path: path.slice(project.length + 1),
    bytes: readFileSync(path).toString("base64"),
    mtimeNs: stats.mtimeNs.toString(),
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(" ")} could not start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${String(result.status)}`
      + `${result.signal === null ? "" : ` (signal ${result.signal})`}:\n`
      + `${result.stderr || result.stdout || "The command produced no output."}`,
    );
  }
  return result.stdout;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function readBootstrapUrl(processHandle) {
  return new Promise((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Hub startup.\n${stderr}`));
    }, 30_000);
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) {
        cleanup();
        resolveUrl(match[0]);
      }
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Hub exited before startup (${code ?? signal}).\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.stdout.off("data", onStdout);
      processHandle.stderr.off("data", onStderr);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout.on("data", onStdout);
    processHandle.stderr.on("data", onStderr);
    processHandle.once("exit", onExit);
  });
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    if (processHandle.exitCode !== null) {
      resolveExit({ code: processHandle.exitCode, signal: processHandle.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Timed out waiting for the packaged Hub to stop."));
    }, timeoutMs);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForJob(origin, cookie, id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/v1/jobs/${encodeURIComponent(id)}`, {
      headers: { cookie },
      redirect: "error",
    });
    const job = await response.json();
    if (!response.ok) throw new Error(`Reading packaged Hub job ${id} failed.`);
    if (job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Packaged Hub job ${id} did not finish before the deadline.`);
}

async function startJob(origin, cookie, csrfToken, kind, forbiddenValues = []) {
  const response = await fetch(`${origin}/api/v1/jobs`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-mex-csrf": csrfToken,
    },
    body: JSON.stringify({ kind }),
    redirect: "error",
  });
  const body = await response.json();
  if (response.status !== 202 || typeof body.id !== "string") {
    throw new Error(`The packaged Hub could not start ${kind}.`);
  }
  const terminal = await waitForJob(origin, cookie, body.id);
  const events = await fetch(`${origin}/api/v1/jobs/${encodeURIComponent(body.id)}/events`, {
    headers: { cookie },
    redirect: "error",
  });
  const stream = await events.text();
  if (
    !events.ok
    || !events.headers.get("content-type")?.startsWith("text/event-stream")
    || !stream.includes("event: terminal")
    || !stream.includes(`\"kind\":\"${kind}\"`)
    || stream.includes("packed-private-session")
    || stream.includes("excluded-only-private-body")
    || forbiddenValues.some((value) => stream.includes(value))
  ) {
    throw new Error(`The packaged Hub did not replay a safe terminal SSE event for ${kind}.`);
  }
  return terminal;
}

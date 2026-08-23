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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const work = mkdtempSync(join(tmpdir(), "mex-hub-pack-smoke-"));
const npmCache = join(work, "npm-cache");
mkdirSync(npmCache, { recursive: true });
let child;

try {
  const packed = run(npm, [
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
  writeFileSync(join(project, ".mex", "wiki.db"), "packed wiki sentinel\n");
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Packed Ada"], project);
  run("git", ["config", "user.email", "packed@example.test"], project);
  run("git", ["add", ".gitignore", "package.json", ".mex", "src"], project);
  run("git", ["commit", "--quiet", "-m", "test fixture"], project);
  run(npm, [
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
    /Hub(?:Job|Api|Session|Capabilities|Activity)|Activity(?:Request|Response|Item|Diagnostic)|CodeWorkspace|GraphHealthDetails|RepositoryGraphPort|runHubCommand/.test(
      declaration,
    )
  ) {
    throw new Error("Private Hub declarations leaked through the package root.");
  }

  const cli = join(installed, "dist", "cli.js");
  run(process.execPath, [cli, "graph", "rebuild", "--root", project, "--json"], project);
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
  ) {
    throw new Error("The packaged Hub capabilities API did not load.");
  }
  const home = await fetch(`${url.origin}/api/v1/home`, {
    headers: { cookie },
    redirect: "error",
  });
  const homeBody = await home.json();
  if (!home.ok || homeBody.sections?.activity?.count !== 1) {
    throw new Error("The packaged Hub did not report the exact canonical activity count.");
  }
  const activity = await fetch(`${url.origin}/api/v1/activity`, {
    headers: { cookie },
    redirect: "error",
  });
  const activityBody = await activity.json();
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
  const health = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const healthBody = await health.json();
  const graphHealth = healthBody.components?.find((component) => component.id === "graph");
  if (!health.ok || graphHealth?.graph?.indexStatus !== "fresh") {
    throw new Error("The packaged Hub did not report fresh graph health.");
  }
  const afterReads = snapshotProtectedProjectState(project);
  if (JSON.stringify(afterReads) !== JSON.stringify(beforeReads)) {
    throw new Error("Reading packaged Home, Activity, Search, Code, or Health mutated protected project state.");
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

  child.kill("SIGTERM");
  const exit = await waitForExit(child, 8_000);
  child = undefined;
  if (exit.signal !== null || exit.code !== 0) {
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

function snapshotProtectedProjectState(project, { includeRuntimeState = true } = {}) {
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
    if (name.startsWith("wiki.db") || (includeRuntimeState && name.startsWith("graph.db"))) {
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
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
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

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  writeFileSync(join(project, ".mex", "ROUTER.md"), "# Project Router\n");
  writeFileSync(
    join(project, ".mex", "config.json"),
    JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "packed-hub-smoke",
    }, null, 2) + "\n",
  );
  run("git", ["init", "--quiet"], project);
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
  if (/Hub(?:Job|Api|Session|Capabilities)|runHubCommand/.test(declaration)) {
    throw new Error("Private Hub declarations leaked through the package root.");
  }

  const cli = join(installed, "dist", "cli.js");
  child = spawn(process.execPath, [cli, "hub", "--no-open"], {
    cwd: project,
    env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bootstrapUrl = await readBootstrapUrl(child);
  const url = new URL(bootstrapUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("The packaged Hub did not emit a bootstrap token.");

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
  if (!session.ok || typeof (await session.json()).csrfToken !== "string") {
    throw new Error("The packaged Hub session API did not load.");
  }
  const capabilities = await fetch(`${url.origin}/api/v1/capabilities`, {
    headers: { cookie },
    redirect: "error",
  });
  if (!capabilities.ok || (await capabilities.json()).apiVersion !== "v1") {
    throw new Error("The packaged Hub capabilities API did not load.");
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

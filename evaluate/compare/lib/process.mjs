import { spawn, spawnSync } from "node:child_process";

export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? (options.encoding === null ? Buffer.alloc(0) : ""), stderr: result.stderr ?? (options.encoding === null ? Buffer.alloc(0) : ""), error: result.error };
}

export function runTimed(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timer;
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr, timedOut, error, elapsedMs: Math.round(performance.now() - started) });
    };
    child.on("error", (error) => finish(1, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 1_000).unref();
    }, options.timeoutMs ?? 300_000);
  });
}

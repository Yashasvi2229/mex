import { HubAssetManifest } from "./static/assets.js";
import { createBootstrapToken, HubSessionManager } from "./security/session.js";
import { createHubApp } from "./app.js";
import { openHubBrowser } from "./browser.js";
import { HubJobManager } from "./jobs/index.js";
import { startHubNodeServer } from "./node-server.js";
import { createLocalHubReadServices } from "./services.js";
import { TeamLocalState } from "../team/local-state/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunHubCommandOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly port?: number;
  readonly openBrowser: boolean;
}

/**
 * Launch the local Hub in the foreground. Startup is the explicit write-side
 * boundary for local schema migration and interrupted-job reconciliation.
 */
export async function runHubCommand(options: RunHubCommandOptions): Promise<void> {
  const localState = new TeamLocalState({
    projectRoot: options.projectRoot,
    scaffoldId: options.scaffoldId,
  });
  const jobs = new HubJobManager({ localState });
  jobs.initialize();
  let server: Awaited<ReturnType<typeof startHubNodeServer>> | undefined;
  try {
    const bootstrapToken = createBootstrapToken();
    let expectedOrigin: string | null = null;
    const security = new HubSessionManager({
      bootstrapToken,
      expectedOrigin: () => expectedOrigin,
    });
    const services = createLocalHubReadServices({
      projectRoot: options.projectRoot,
      scaffoldId: options.scaffoldId,
      jobs,
    });
    const assets = new HubAssetManifest(resolveHubAssetRoot());
    const app = createHubApp({ security, services, jobs, assets });

    server = await startHubNodeServer({ app, port: options.port });
    expectedOrigin = server.origin;
    const bootstrapUrl = `${server.origin}/#token=${encodeURIComponent(bootstrapToken)}`;

    process.stdout.write(`\nProject Hub running at ${server.origin}\n`);
    process.stdout.write(`One-time bootstrap link (valid for 5 minutes):\n${bootstrapUrl}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n\n");
    if (options.openBrowser) openHubBrowser(bootstrapUrl);
    await waitForShutdownSignal();
  } finally {
    // Stop accepting requests before aborting or reconciling any executors.
    try {
      await server?.close();
    } finally {
      await jobs.shutdown();
    }
  }
}

export function resolveHubAssetRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "hub");
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      process.off("SIGINT", complete);
      process.off("SIGTERM", complete);
      resolve();
    };
    process.once("SIGINT", complete);
    process.once("SIGTERM", complete);
  });
}

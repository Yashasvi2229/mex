import { releaseWorkbenchPaths } from "./routes.mjs";

const PAGE_READY_TIMEOUT_MS = 30_000;

/**
 * Measure each workbench in a new browser context so route-to-route caches do
 * not make later pages look artificially small. The request audit is part of
 * the benchmark contract: a release benchmark must fail if a production Hub
 * workbench contacts anything other than the exact loopback Hub origin.
 */
export async function measureWorkbenchHeap({
  server,
  auth,
  samples,
  knowledgeEntityId,
  codeSymbolId,
}) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const workbenchPaths = releaseWorkbenchPaths({ knowledgeEntityId, codeSymbolId });
  const measurements = Object.fromEntries(
    Object.keys(workbenchPaths).map((route) => [route, []]),
  );
  const observedRequests = new Set();
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      for (const [route, path] of Object.entries(workbenchPaths)) {
        const context = await browser.newContext({
          reducedMotion: "reduce",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        });
        const outbound = new Set();
        context.on("request", (request) => {
          const url = new URL(request.url());
          observedRequests.add(`${request.method()} ${url.pathname}`);
          if (url.origin !== server.origin) outbound.add(request.url());
        });
        await addApiCookie(context, server.origin, auth.cookie);
        const page = await context.newPage();
        try {
          const response = await page.goto(`${server.origin}${path}`, {
            waitUntil: "networkidle",
            timeout: PAGE_READY_TIMEOUT_MS,
          });
          if (!response?.ok()) {
            throw new Error(`${route} returned HTTP ${String(response?.status() ?? "none")}.`);
          }
          // Give React one task turn to commit route content after network idle.
          await page.waitForTimeout(50);
          if (outbound.size > 0) {
            throw new Error(
              `${route} made outbound requests: ${[...outbound].sort().slice(0, 10).join(", ")}`,
            );
          }
          const cdp = await context.newCDPSession(page);
          await cdp.send("HeapProfiler.collectGarbage");
          const heap = await cdp.send("Runtime.getHeapUsage");
          if (!Number.isFinite(heap.usedSize) || heap.usedSize < 0) {
            throw new Error(`${route} returned an invalid browser heap measurement.`);
          }
          measurements[route].push(heap.usedSize);
          await cdp.detach();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return {
    measurements,
    outboundRequestCount: 0,
    observedLoopbackRequests: [...observedRequests].sort().slice(0, 100),
  };
}

async function addApiCookie(context, origin, serializedCookie) {
  const separator = serializedCookie.indexOf("=");
  if (separator <= 0) throw new Error("The Hub session cookie is malformed.");
  const url = new URL(origin);
  await context.addCookies([{
    name: serializedCookie.slice(0, separator),
    value: serializedCookie.slice(separator + 1),
    domain: url.hostname,
    path: "/api/v1",
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
  }]);
}

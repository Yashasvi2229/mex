import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runningJobId = "job_01K36WVM6H7JK8M9NPQRSTVVWX";

function watchBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectAccessible(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page }).analyze();
  expect(report.violations).toEqual([]);
}

async function expectLoadedActivity(page: Page, count: number): Promise<void> {
  const liveRegion = page.locator('[aria-live="polite"]');
  await expect(liveRegion.getByText(String(count), { exact: true })).toBeVisible();
  await expect(liveRegion.getByText(count === 1 ? "event loaded" : "events loaded", { exact: true })).toBeVisible();
}

test.describe("populated development fixture", () => {
  test("renders the deterministic Home workbench", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Good context starts here." })).toBeVisible();
    await expect(page.getByLabel("Repository context").getByText("feat/project-hub-foundation", { exact: true })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot("hub-home.png", { fullPage: true });
  });

  test("keeps Search sources separate under partial failure", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/search?fixture=populated&q=freshness");
    await expect(page.getByRole("heading", { name: "Search the project" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await expect(page.getByText("This source failed independently.")).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot("hub-search.png", { fullPage: true });
  });

  test("renders Health without inventing repair availability", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/health?fixture=populated");
    await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
    await expect(page.getByText("The previous trustworthy index was preserved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot("hub-health.png", { fullPage: true });
  });

  test("renders persisted Jobs and an honest detail workspace", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto(`/jobs?fixture=populated&job=${runningJobId}`);
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Job detail" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Job detail" }).getByRole("progressbar", { name: "68% complete" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebuild Wiki" })).toBeDisabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot("hub-jobs.png", { fullPage: true });
  });

  test("renders the real Activity workbench with bounded, expandable history", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/activity?fixture=populated");

    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByText("Read only", { exact: true })).toBeVisible();
    await expectLoadedActivity(page, 4);
    await expect(page.getByText("Some history could not be trusted.")).toBeVisible();
    await expect(page.getByText("Hub activity view connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Recorded as Daksh Jaitly", { exact: true })).toBeVisible();

    const firstDisclosure = page.getByRole("button", { name: "Show details" }).first();
    await firstDisclosure.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Hide details" }).first()).toBeFocused();
    await expect(page.getByText("event_01K36WVM6H7JK8M9NPQRSTVVWX", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Recorded repository state" })).toBeVisible();

    await expectAccessible(page);
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot("hub-activity.png", { fullPage: true });
  });

  test("keeps Activity filters in history and paginates without mixing disclosures", async ({ page }) => {
    await page.goto("/activity?fixture=populated");
    await expectLoadedActivity(page, 4);

    await page.getByRole("button", { name: "Show details" }).first().click();
    await page.getByRole("button", { name: "Load older activity" }).click();
    await expectLoadedActivity(page, 6);
    await expect(page.getByText("End of trustworthy history", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Legacy", exact: true }).click();
    await expect(page).toHaveURL(/fixture=populated/);
    await expect(page).toHaveURL(/source=legacy/);
    await expect(page.locator('article[data-source="legacy"]')).toHaveCount(2);
    await expect(page.locator('article[data-source="activity"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide details" })).toHaveCount(0);

    await page.getByLabel("Since").fill("2026-08-23");
    await expect(page).toHaveURL(/since=2026-08-23/);
    await expect(page.locator('article[data-source="legacy"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Clear date" }).click();
    await expect(page).not.toHaveURL(/since=/);

    await page.goBack();
    await expect(page.getByLabel("Since")).toHaveValue("2026-08-23");
    await page.goBack();
    await expect(page.getByRole("button", { name: "Legacy", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps Activity accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/activity?fixture=populated");
      await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();

      const disclosure = page.getByRole("button", { name: "Show details" }).first();
      const transitionDuration = await disclosure.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      );
      expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  test("supports keyboard routing, focus restoration, every shell, and 404", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    const routes = [
      ["Knowledge", "Knowledge"],
      ["Code", "Code"],
      ["Workstreams", "Workstreams"],
      ["Specs", "Specs"],
      ["Playbooks", "Playbooks"],
      ["Inbox", "Inbox"],
      ["Relays", "Relays"],
      ["Activity", "Activity"],
    ] as const;
    for (const [link, heading] of routes) {
      await page.getByRole("link", { name: new RegExp(`^${link}(?: Unavailable)?$`) }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator("#main-content")).toBeFocused();
    }
    await page.goto("/outside-the-workbench?fixture=populated");
    await expect(page.getByText("404", { exact: true })).toBeVisible();
  });

  test("uses the desktop guard at 1023px", async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 800 });
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });

  for (const width of [1440, 1024] as const) {
    test(`fits the complete desktop workbench at exactly ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?fixture=populated");
      await expect(page.getByRole("heading", { name: "Good context starts here." })).toBeVisible();

      const sidebar = await page.locator('aside[aria-label="Project Hub navigation"]').boundingBox();
      expect(sidebar?.width).toBe(232);
      expect(sidebar?.x).toBe(0);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
    });
  }

  test("suppresses computed transitions and animation under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/jobs?fixture=populated");
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();

    const navTransitionDuration = await page.getByRole("link", { name: "Home", exact: true })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    const spinner = page.locator("svg.lucide-loader-circle").first();
    await expect(spinner).toBeVisible();
    const spinnerMotion = await spinner.evaluate((element) => {
      const style = getComputedStyle(element);
      return { animationName: style.animationName, animationDuration: style.animationDuration };
    });

    expect(Number.parseFloat(navTransitionDuration)).toBeLessThanOrEqual(0.00001);
    expect(spinnerMotion.animationName).toBe("none");
    expect(Number.parseFloat(spinnerMotion.animationDuration)).toBeLessThanOrEqual(0.00001);
  });

  test("never requests an external asset or API", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      const host = new URL(request.url()).hostname;
      if (host !== "127.0.0.1") external.push(request.url());
    });
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Good context starts here." })).toBeVisible();
    await page.goto("/activity?fixture=populated");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    expect(external).toEqual([]);
  });
});

test.describe("built production Hub", () => {
  test.describe.configure({ mode: "serial" });
  let processHandle: ChildProcess | undefined;
  let projectRoot: string | undefined;
  let bootstrapUrl: string;

  test.beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-browser-"));
    mkdirSync(join(projectRoot, ".mex"), { recursive: true });
    writeFileSync(join(projectRoot, ".mex", "ROUTER.md"), "# Browser fixture\n");
    writeFileSync(
      join(projectRoot, ".mex", "config.json"),
      JSON.stringify({
        scaffold_id: "22222222-2222-4222-8222-222222222222",
        scaffold_name: "production-hub-fixture",
      }, null, 2) + "\n",
    );
    writeProductionActivity(projectRoot);
    const git = spawnSync("git", ["init", "--quiet"], { cwd: projectRoot, encoding: "utf8" });
    if (git.status !== 0) throw new Error(git.stderr);
    processHandle = spawn(process.execPath, [join(root, "dist", "cli.js"), "hub", "--no-open"], {
      cwd: projectRoot,
      env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bootstrapUrl = await readBootstrapUrl(processHandle);
  });

  test.afterAll(async () => {
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await waitForExit(processHandle, 8_000);
    }
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  test("bootstraps once, cleans the fragment, and never exposes fixture content", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const response = await page.goto(bootstrapUrl);
    await expect(page.getByRole("heading", { name: "Good context starts here." })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain("#token=");
    await expect(page.getByText("Knowledge and code indexes are unavailable.")).toBeVisible();
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);

    await page.goto(`${new URL(bootstrapUrl).origin}/?fixture=populated`);
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);
    await expect(page.getByText("Knowledge and code indexes are unavailable.")).toBeVisible();

    await page.goto(`${new URL(bootstrapUrl).origin}/activity?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByText("Production real read", { exact: true })).toBeVisible();
    await expect(page.getByText("Production legacy decision", { exact: true })).toBeVisible();
    await expect(page.getByText("Hub activity view connected", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Keep activity immutable and preserve legacy history", { exact: false })).toHaveCount(0);
    await expect(page.getByText("production metadata sentinel", { exact: true })).toHaveCount(0);
    await expect(page.getByText("/private/production/path", { exact: true })).toHaveCount(0);
    await expect(page.getByText(".mex/traces/production-private.md", { exact: true })).toHaveCount(0);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });
});

function writeProductionActivity(projectRoot: string): void {
  const eventId = "event_01K3Q080000000000000000004";
  const month = join(projectRoot, ".mex", "events", "activity", "2026-08");
  mkdirSync(month, { recursive: true });
  writeFileSync(join(month, `${eventId}.md`), [
    "---",
    "schema_version: 1",
    `id: ${JSON.stringify(eventId)}`,
    "timestamp: \"2026-08-23T03:00:00.000Z\"",
    "actor: {\"kind\":\"unknown\"}",
    "action: \"production.real_read\"",
    "subjects: [{\"kind\":\"file\",\"path\":\"src/production.ts\"}]",
    "repo_state: {\"branch\":null,\"dirty\":false,\"head\":null,\"observedAt\":\"2026-08-23T02:59:59.000Z\"}",
    "metadata: {\"internal_note\":\"production metadata sentinel\"}",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(projectRoot, ".mex", "events", "decisions.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-22T03:00:00.000Z",
    kind: "decision",
    message: "Production legacy decision",
    files: ["src/production.ts"],
    cwd: "/private/production/path",
    trace: ".mex/traces/production-private.md",
  })}\n`);
}

function readBootstrapUrl(processHandle: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Hub startup.\n${stderr}`));
    }, 30_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) {
        cleanup();
        resolveUrl(match[0]);
      }
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf8"); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Hub exited before startup (${code ?? signal}).\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.stdout?.off("data", onStdout);
      processHandle.stderr?.off("data", onStderr);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout?.on("data", onStdout);
    processHandle.stderr?.on("data", onStderr);
    processHandle.once("exit", onExit);
  });
}

function waitForExit(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, reject) => {
    if (processHandle.exitCode !== null) {
      resolveExit();
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Timed out waiting for Hub shutdown."));
    }, timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

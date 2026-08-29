import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function normalizeEstablishedVisualGolden(
  page: Page,
  surface?: "home" | "activity",
): Promise<void> {
  if (surface === "home") {
    const summary = page.getByRole("region", { name: "Project summary" });
    await summary.getByText("Canonical delivery threads", { exact: true }).evaluate((element) => {
      element.textContent = "Not connected";
    });
    await summary.getByText("3", { exact: true }).evaluate((element) => {
      element.textContent = "—";
    });
    await summary.locator('a[href="/workstreams"]').evaluate((element) => {
      const card = element.firstElementChild;
      if (!card) throw new Error("The Workstream visual golden card is unavailable.");
      element.replaceWith(card);
    });
    await page.getByRole("region", { name: "Project sections" }).evaluate((element) => {
      const rows = [...element.querySelectorAll<HTMLElement>('[role="listitem"]')];
      for (const label of ["Workstreams", "Relays", "Inbox"]) {
        const row = rows.find((candidate) => candidate.textContent?.includes(label));
        const status = row?.querySelector<HTMLElement>('[data-tone]');
        if (!status) throw new Error(`The ${label} visual golden status is unavailable.`);
        status.dataset.tone = "warning";
        status.textContent = "Unavailable";
      }
    });
    await page.locator('a[aria-label^="Open member identity for"]').evaluate((element) => {
      const template = document.querySelector<HTMLElement>('[data-slot="badge"][data-variant="outline"]');
      if (!template) throw new Error("The visual golden badge template is unavailable.");
      const badge = document.createElement("span");
      badge.className = template.className.split(/\s+/).filter((name) => !name.startsWith("_")).join(" ");
      badge.dataset.slot = "badge";
      badge.dataset.variant = "outline";
      for (const child of [...element.childNodes]) badge.append(child);
      badge.querySelector('[data-icon="inline-end"]')?.remove();
      const text = [...badge.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      if (text) text.textContent = " Daksh";
      element.replaceWith(badge);
    });
  }
  if (surface === "activity") {
    await page.getByRole("button", { name: "Record Activity" }).evaluate((element) => element.remove());
    await page.getByText("Append only", { exact: true }).evaluate((element) => {
      const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      if (text) text.textContent = " Read only";
      element.parentElement?.replaceWith(element);
    });
  }
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
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByLabel("Repository context").getByText("feat/project-hub-foundation", { exact: true })).toBeVisible();
    await expect(page.getByText("The code graph is behind this branch", { exact: true })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page, "home");
    await expect(page).toHaveScreenshot("hub-home.png", { fullPage: true });
  });

  test("keeps real Wiki, symbol, and source search groups separate", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/search?fixture=populated&q=hub");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source matches" })).toBeVisible();
    await expect(page.getByRole("link", { name: /createHubServer/ }).first()).toBeVisible();
    await expect(page.getByText(/export async function createHubServer/)).toBeVisible();
    await expect(page.getByText("This source failed independently.")).toHaveCount(0);
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page);
    await expect(page).toHaveScreenshot("hub-search.png", { fullPage: true });
  });

  test("browses, filters, paginates, and restores URL-backed Knowledge state", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/knowledge?fixture=populated");

    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByText("Browse durable project memory", { exact: false })).toBeVisible();
    const summary = page.getByText("All Knowledge records", { exact: true }).locator("..");
    await expect(summary).toBeFocused();
    await expect(page.getByText("2 loaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load more Knowledge" }).click();
    await expect(page.getByText("3 loaded", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Review immutable activity/ })).toBeVisible();

    await page.getByLabel("Kind").fill("decision");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/kind=decision/);
    const filteredSummary = page.getByText("Filtered Knowledge records", { exact: true }).locator("..");
    await expect(filteredSummary).toBeVisible();
    await expect(filteredSummary).toBeFocused();
    await expect(page.getByRole("link", { name: /One snapshot per graph request/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(page).not.toHaveURL(/kind=/);
    await expect(page.getByText("All Knowledge records", { exact: true }).locator("..")).toBeFocused();
    const searchbox = page.getByRole("searchbox", { name: "Search titles, summaries, and bodies" });
    await expect(searchbox).toHaveValue("");
    await searchbox.fill("snapshot");
    const apply = page.getByRole("button", { name: "Apply" });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page).toHaveURL(/q=snapshot/);
    await expect(page.getByText("Knowledge results for “snapshot”", { exact: true }).locator("..")).toBeFocused();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders the read-only Knowledge record with keyboard links and exact grounding", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const external: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");

    await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    await expect(page.getByText("architecture · Knowledge record", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Record body" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Code grounding" })).toBeVisible();
    await expect(page.getByRole("link", { name: /sym\.createHubServer/ })).toHaveAttribute(
      "href",
      "/code/symbols/sym.createHubServer",
    );
    await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provenance" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Knowledge body as plain text" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Relations" }).getByText("One snapshot per graph request", { exact: true })).toBeVisible();

    await expectAccessible(page);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page);
    await expect(page).toHaveScreenshot("hub-knowledge.png", { fullPage: true });

    const relations = page.getByRole("tab", { name: "Relations" });
    await relations.focus();
    await page.keyboard.press("ArrowRight");
    const backlinks = page.getByRole("tab", { name: "Backlinks" });
    await expect(backlinks).toBeFocused();
    await expect(backlinks).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Backlinks" }).getByText("Review immutable activity", { exact: true })).toBeVisible();
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps the Knowledge workspace accessible and correctly arranged at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");
      await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();

      const identity = await page.getByRole("heading", { name: "Record identity" }).boundingBox();
      const body = await page.getByRole("heading", { name: "Record body" }).boundingBox();
      const evidence = await page.getByRole("heading", { name: "Code grounding" }).boundingBox();
      expect(identity).not.toBeNull();
      expect(body).not.toBeNull();
      expect(evidence).not.toBeNull();
      if (width === 1440) {
        expect(identity!.x).toBeLessThan(body!.x);
        expect(body!.x).toBeLessThan(evidence!.x);
      } else {
        expect(identity!.y).toBeLessThan(body!.y);
        expect(body!.y).toBeLessThan(evidence!.y);
      }
      const transitionDuration = await page.getByRole("link", { name: /sym\.createHubServer/ })
        .evaluate((element) => getComputedStyle(element).transitionDuration);
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

  test("renders the deterministic Code landing and exact symbol workspace", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const external: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code?fixture=populated");

    await expect(page.getByRole("heading", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search symbols and source" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search code symbols and source" }).fill("hub");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source matches" })).toBeVisible();
    await page.getByRole("link", { name: /createHubServer/ }).first().click();

    await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    const specimen = page.getByRole("region", { name: "src/hub/server.ts, lines 74 through 84" });
    await expect(specimen).toBeVisible();
    await expect.poll(() => specimen.locator("code").allTextContents()).toEqual([
      "export async function createHubServer(options: HubServerOptions) {",
      "  const app = createHubApp(options);",
      "  const server = await listenOnLoopback(app, options.port);",
      "  return { server, address: server.address() };",
      "}",
    ]);
    await expect(page.getByText("sha256:888888888888", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Related Knowledge" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toBeVisible();
    await expectAccessible(page);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page);
    await expect(page).toHaveScreenshot("hub-code.png", { fullPage: true });
  });

  test("uses keyboard tabs for callers, callees, and dependent impact", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
    const overview = page.getByRole("tab", { name: "Overview" });
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await overview.focus();

    await page.keyboard.press("ArrowRight");
    const callers = page.getByRole("tab", { name: "Callers" });
    await expect(callers).toBeFocused();
    await expect(callers).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=callers$/);
    await expect(page.getByRole("tabpanel", { name: "Callers" }).getByText("sym.GraphPort.searchNodes", { exact: true })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    const callees = page.getByRole("tab", { name: "Callees" });
    await expect(callees).toBeFocused();
    await expect(callees).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=callees$/);
    await expect(page.getByRole("tabpanel", { name: "Callees" }).getByText("sym.GraphPort.searchNodes", { exact: true })).toBeVisible();

    await page.keyboard.press("End");
    const impact = page.getByRole("tab", { name: "Impact" });
    await expect(impact).toBeFocused();
    await expect(impact).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=impact&depth=2$/);
    const impactPanel = page.getByRole("tabpanel", { name: "Impact" });
    await expect(impactPanel.getByRole("heading", { name: "Dependent blast radius" })).toBeVisible();
    await expect(impactPanel.getByText("1 affected dependents", { exact: true })).toBeVisible();
    await expect(impactPanel.getByText(/downstream/i)).toHaveCount(0);
    await expectAccessible(page);

    await page.keyboard.press("Home");
    await expect(overview).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/code\/symbols\/sym\.createHubServer$/);
    expect(errors).toEqual([]);
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps the Code observatory accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
      await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();

      const identity = await page.getByRole("heading", { level: 2, name: "createHubServer" }).locator("xpath=ancestor::section[1]").boundingBox();
      const source = await page.getByRole("heading", { name: "Source specimen" }).locator("xpath=ancestor::section[1]").boundingBox();
      const traversal = await page.getByRole("tabpanel", { name: "Overview" }).boundingBox();
      expect(identity).not.toBeNull();
      expect(source).not.toBeNull();
      expect(traversal).not.toBeNull();
      if (width === 1440) {
        expect(identity!.x).toBeLessThan(source!.x);
        expect(source!.x).toBeLessThan(traversal!.x);
        expect(Math.abs(identity!.y - source!.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(source!.y - traversal!.y)).toBeLessThanOrEqual(1);
      } else {
        expect(identity!.y).toBeLessThan(source!.y);
        expect(source!.y).toBeLessThan(traversal!.y);
      }
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

  test("suppresses Code traversal motion when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code/symbols/sym.createHubServer?fixture=populated&view=callers");
    const relation = page.getByRole("tabpanel", { name: "Callers" }).getByRole("link").first();
    await expect(relation).toBeVisible();
    const motion = await relation.evaluate((element) => {
      const style = getComputedStyle(element);
      return { transitionDuration: style.transitionDuration, animationDuration: style.animationDuration };
    });
    expect(Number.parseFloat(motion.transitionDuration)).toBeLessThanOrEqual(0.00001);
    expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.00001);
  });

  test("renders structured Graph Health without inventing repair availability", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/health?fixture=populated");
    await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
    await expect(page.getByText("Indexed snapshot", { exact: true })).toBeVisible();
    await expect(page.getByText("Current repository", { exact: true })).toBeVisible();
    await expect(page.getByText("179/183", { exact: true })).toBeVisible();
    await expect(page.getByText("Branch changed", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View active job" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Refresh graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Rebuild graph/ })).toBeDisabled();
    await expect(page.getByText("The previous trustworthy index was preserved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Wiki refresh" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
    await expect(page.getByLabel("Services").getByText("New operations wait for the active job.", { exact: true })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page);
    await expect(page).toHaveScreenshot("hub-health.png", { fullPage: true });
  });

  test("renders persisted Jobs and an honest detail workspace", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto(`/jobs?fixture=populated&job=${runningJobId}`);
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Job detail" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Job detail" }).getByRole("progressbar", { name: "68% complete" })).toBeVisible();
    await expect(page.getByLabel("Graph operation phases").getByText("Parse", { exact: true })).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("button", { name: /^Refresh graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Rebuild graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Rebuild Wiki" })).toBeDisabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    await normalizeEstablishedVisualGolden(page);
    await expect(page).toHaveScreenshot("hub-jobs.png", { fullPage: true });
  });

  test("reviews canonical member changes separately and keeps selection local", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/members?fixture=populated");

    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await expect(page.locator("#current-actor-heading")).toHaveText("Ada Lovelace");
    await expect(page.getByText("Selected for this checkout", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Grace Hopper/ })).toBeVisible();

    await page.getByRole("button", { name: /Grace Hopper/ }).click();
    await page.getByRole("button", { name: "Select locally" }).click();
    const selectDialog = page.getByRole("dialog", { name: "Select Grace Hopper" });
    await expect(selectDialog.getByText(/emits no Activity event/).first()).toBeVisible();
    await selectDialog.getByRole("button", { name: "Preview change" }).click();
    await expect(selectDialog.getByRole("heading", { name: "Operation preview" })).toBeVisible();
    await selectDialog.getByRole("button", { name: "Review apply" }).click();
    await page.getByRole("button", { name: "Apply approved preview" }).click();
    await expect(page.getByText("Local member selection updated. No Activity event was created.")).toBeVisible();
    await expect(page.locator("#current-actor-heading")).toHaveText("Grace Hopper");

    await page.getByRole("button", { name: "Clear selection" }).click();
    const clearDialog = page.getByRole("dialog", { name: "Clear current member" });
    await clearDialog.getByRole("button", { name: "Preview change" }).click();
    await clearDialog.getByRole("button", { name: "Review apply" }).click();
    await page.getByRole("button", { name: "Apply approved preview" }).click();
    await expect(page.getByText("Git identity fallback", { exact: true })).toBeVisible();

    const addMember = page.getByRole("button", { name: "Add member" });
    await addMember.click();
    const addDialog = page.getByRole("dialog", { name: "Add member" });
    await expect(addDialog.getByRole("textbox", { name: "Display name" })).toBeFocused();
    await addDialog.getByRole("textbox", { name: "Display name" }).fill("Katherine Johnson");
    await addDialog.getByRole("textbox", { name: /Git aliases/ }).fill("Katherine | kj@example.test");
    await addDialog.getByRole("button", { name: "Preview change" }).click();
    await expect(addDialog.getByRole("heading", { name: "Operation preview" })).toBeVisible();
    await addDialog.getByRole("button", { name: "Review apply" }).click();
    await page.getByRole("button", { name: "Apply approved preview" }).click();
    await expect(page.locator("#member-detail-heading")).toHaveText("Katherine Johnson");
    await expect(page.getByText("Canonical member change applied with one immutable Activity event.")).toBeVisible();

    await page.getByRole("button", { name: "Update" }).click();
    const updateDialog = page.getByRole("dialog", { name: "Update Katherine Johnson" });
    await updateDialog.getByRole("textbox", { name: "Display name" }).fill("Katherine G. Johnson");
    await updateDialog.getByRole("button", { name: "Preview change" }).click();
    await updateDialog.getByRole("button", { name: "Review apply" }).click();
    await page.getByRole("button", { name: "Apply approved preview" }).click();
    await expect(page.locator("#member-detail-heading")).toHaveText("Katherine G. Johnson");

    await page.getByRole("button", { name: "Deactivate" }).click();
    const deactivateDialog = page.getByRole("dialog", { name: "Deactivate Katherine G. Johnson" });
    await deactivateDialog.getByRole("button", { name: "Preview change" }).click();
    await deactivateDialog.getByRole("button", { name: "Review apply" }).click();
    await page.getByRole("button", { name: "Apply approved preview" }).click();
    await expect(page.getByRole("region", { name: "Selected member detail" }).getByText("Inactive", { exact: true })).toBeVisible();

    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps Members accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/members?fixture=populated");
      await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();

      const directory = await page.getByRole("region", { name: "Team roster" }).boundingBox();
      const detail = await page.getByRole("region", { name: "Selected member detail" }).boundingBox();
      expect(directory).not.toBeNull();
      expect(detail).not.toBeNull();
      if (width === 1440) expect(directory!.x).toBeLessThan(detail!.x);
      else expect(directory!.y).toBeLessThan(detail!.y);
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

  test("renders the real Activity workbench with bounded, expandable history", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/activity?fixture=populated");

    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByText("Append only", { exact: true })).toBeVisible();
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
    // Keep the long-lived timeline visual golden focused on history layout.
    // The append controls have dedicated keyboard, axe, and interaction coverage below.
    await normalizeEstablishedVisualGolden(page, "activity");
    await expect(page).toHaveScreenshot("hub-activity.png", { fullPage: true });
  });

  test("records Activity only after preview and a separate explicit apply", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/activity?fixture=populated");
    await expectLoadedActivity(page, 4);

    const trigger = page.getByRole("button", { name: "Record Activity" });
    await trigger.click();
    let dialog = page.getByRole("dialog", { name: "Record Activity" });
    await expect(dialog.getByRole("textbox", { name: /Action/ })).toBeFocused();
    await expect(dialog.getByText(/service captures actor, timestamp, branch, HEAD, and dirty state/i)).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    dialog = page.getByRole("dialog", { name: "Record Activity" });
    await dialog.getByRole("textbox", { name: /Action/ }).fill("review.approved");
    await dialog.getByRole("textbox", { name: /Subject references/ }).fill("file:src/review.ts");
    await dialog.getByRole("button", { name: "Preview append" }).click();
    await expect(dialog.getByRole("heading", { name: "Operation preview" })).toBeVisible();
    await dialog.getByRole("button", { name: "Review apply" }).click();
    await expect(page.getByText("Apply this exact preview?")).toBeVisible();
    await page.getByRole("button", { name: "Apply approved preview" }).click();

    await expect(page.getByText(/was appended as an immutable canonical record/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review approved" })).toBeVisible();
    await expectLoadedActivity(page, 4);
    await expectAccessible(page);
    expect(errors).toEqual([]);
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

  for (const route of ["workstreams", "specs"] as const) {
    for (const width of [390, 768, 1440] as const) {
      test(`keeps ${route} accessible and overflow-free at ${width}px`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${route}?fixture=populated`);

        if (width < 1024) {
          await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
        } else {
          const heading = route === "workstreams" ? "Workstreams" : "Specs";
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          if (route === "workstreams") {
            await expect(page.getByRole("region", { name: "Selected Workstream detail" })).toBeVisible();
          } else {
            await expect(page.getByRole("region", { name: "Selected Spec detail" })).toBeVisible();
            await expect(page.getByText("No inferred coverage.")).toBeVisible();
          }
        }

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
  }

  for (const width of [390, 768, 1024, 1440] as const) {
    test(`keeps Inbox accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/inbox?fixture=populated");

      if (width < 1024) {
        await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      } else {
        await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
        await expect(page.locator('[data-inbox-workbench="ready"]')).toBeVisible();
        await expect(page.locator(
          '[data-inbox-draft-id="inbox_00000000000000000000000000000001"]',
        )).toContainText("Release benchmark local draft Requirement");
        await expect(page.locator(
          '[data-inbox-proposal-id="proposal_01000000000000000000001720"]',
        )).toContainText("Release benchmark pending Spec update");
      }

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

  test("keeps Inbox selection and review dialogs keyboard complete", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated");
    await expect(page.locator('[data-inbox-workbench="ready"]')).toBeVisible();

    const draft = page.locator('[data-inbox-draft-id="inbox_00000000000000000000000000000001"]');
    const proposal = page.locator('[data-inbox-proposal-id="proposal_01000000000000000000001720"]');
    await expect(draft).toContainText("Release benchmark local draft Requirement");
    await expect(proposal).toContainText("Release benchmark pending Spec update");

    await draft.focus();
    await page.keyboard.press("Enter");
    await expect(draft).toHaveAttribute("aria-current", "true");
    await expect(draft).toHaveAttribute("data-selected", "true");
    await expect(page.getByRole("region", { name: "Selected Inbox review detail" })
      .getByRole("heading", { name: "Release benchmark local draft Requirement", exact: true })).toBeVisible();

    const createDraft = page.getByRole("button", { name: "New local draft", exact: true });
    await createDraft.click();
    const editor = page.getByRole("dialog", { name: "Create local Spec draft" });
    await expect(editor).toBeVisible();
    await expect(editor.getByText(
      "This draft stays private to this checkout. Previewing and saving it does not publish canonical project memory.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByLabel("Change type", { exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => editor.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(createDraft).toBeFocused();

    await proposal.focus();
    await page.keyboard.press("Enter");
    await expect(proposal).toHaveAttribute("aria-current", "true");
    await expect(proposal).toHaveAttribute("data-selected", "true");
    await expect(page.getByRole("region", { name: "Selected Inbox review detail" })
      .getByRole("heading", { name: "Release benchmark pending Spec update", exact: true })).toBeVisible();

    const approve = page.getByRole("button", { name: "Review & approve", exact: true });
    await approve.click();
    const review = page.getByRole("dialog", { name: "Review proposal for approval" });
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Preview Spec approval", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(approve).toBeFocused();
  });

  for (const width of [390, 768, 1024, 1440] as const) {
    test(`keeps Relay guarded or overflow-free and accessible at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/relays?fixture=populated");

      if (width < 1024) {
        await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      } else {
        await expect(page.getByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
        await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();
        await expect(page.locator('[data-relay-draft-id="relay-draft-01"]')).toContainText(
          "Carry the release evidence through the final cross-platform gate.",
        );
        await expect(page.locator('[data-relay-id="relay_01000000000000000000000001"]')).toContainText(
          "Release evidence is ready for the final cross-platform gate.",
        );
        const drafts = await page.getByRole("region", { name: "Draft rail" }).boundingBox();
        const desk = await page.getByRole("region", { name: "Relay desk" }).boundingBox();
        expect(drafts).not.toBeNull();
        expect(desk).not.toBeNull();
        expect(drafts!.x).toBeLessThan(desk!.x);
      }

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

  test("keeps Relay keyboard selection, composer, and signed review focus complete", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/relays?fixture=populated");
    await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();

    const draft = page.locator('[data-relay-draft-id="relay-draft-01"]');
    await draft.focus();
    await page.keyboard.press("Enter");
    await expect(draft).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("region", { name: "Selected Relay detail" })
      .getByRole("heading", { name: "Carry the release evidence through the final cross-platform gate." })).toBeVisible();

    const relay = page.locator('[data-relay-id="relay_01000000000000000000000001"]');
    await relay.focus();
    await page.keyboard.press("Enter");
    await expect(relay).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("region", { name: "Selected Relay detail" })
      .getByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();

    const compose = page.getByRole("button", { name: "New local draft", exact: true });
    await compose.click();
    const composer = page.getByRole("dialog", { name: "Compose a local Relay draft" });
    await expect(composer).toBeVisible();
    await expect.poll(() => composer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => composer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();
    await expect(compose).toBeFocused();

    const claim = page.getByRole("button", { name: "Claim handoff", exact: true });
    await claim.click();
    const review = page.getByRole("alertdialog", { name: "Review the exact Relay operation" });
    await expect(review.getByRole("heading", { name: "Exact handoff docket" })).toBeVisible();
    await expect.poll(() => review.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => review.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(claim).toBeFocused();
  });

  test("loads Relay lazily with one local chunk and stays external-free and idle", async ({ page }) => {
    const requests: string[] = [];
    const external: string[] = [];
    const apiWrites: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.hostname !== "127.0.0.1") external.push(request.url());
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        apiWrites.push(`${request.method()} ${url.pathname}`);
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    expect(requests.some((request) => request.includes("/src/pages/RelayPage.tsx"))).toBe(false);

    await page.getByRole("link", { name: /^Relays(?: |$)/ }).click();
    await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.filter((request) => request === "GET /src/pages/RelayPage.tsx")).toHaveLength(1);
    const idleRequestCount = requests.length;
    await page.waitForTimeout(5_500);
    expect(requests).toHaveLength(idleRequestCount);
    expect(apiWrites).toEqual([]);
    expect(external).toEqual([]);
  });

  test("renders the exact sidebar IA and keeps disclosures independent and reload-local", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    const primary = page.getByRole("navigation", { name: "Primary" });
    const utilities = page.getByRole("navigation", { name: "Project utilities" });
    const projectMemory = primary.getByRole("region", { name: "Project Memory" });
    const teamwork = primary.getByRole("region", { name: "Teamwork" });
    const comingSoon = primary.getByRole("region", { name: "Coming Soon" });
    const system = utilities.getByRole("region", { name: /^System/ });
    const projectMemoryDisclosure = projectMemory.getByRole("button", { name: "Project Memory" });
    const teamworkDisclosure = teamwork.getByRole("button", { name: "Teamwork" });
    const comingSoonDisclosure = comingSoon.getByRole("button", { name: "Coming Soon" });
    const systemDisclosure = system.getByRole("button", { name: /^System/ });

    await expect(sidebar.getByRole("link", { name: "Search project", exact: true }))
      .toHaveAttribute("aria-keyshortcuts", "/");
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(comingSoonDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "false");

    await comingSoonDisclosure.click();
    await systemDisclosure.click();
    const primaryItems = await primary.getByRole("link").evaluateAll((links) => links.map((link) => ({
      href: link.getAttribute("href"),
      label: [...link.children].find((child) => (
        child.tagName === "SPAN" && !child.hasAttribute("data-slot")
      ))?.textContent,
    })));
    expect(primaryItems).toEqual([
      { href: "/", label: "Overview" },
      { href: "/knowledge", label: "Knowledge" },
      { href: "/specs", label: "Specs" },
      { href: "/code", label: "Code" },
      { href: "/workstreams", label: "Workstreams" },
      { href: "/inbox", label: "Inbox" },
      { href: "/relays", label: "Relays" },
      { href: "/activity", label: "Activity" },
      { href: "/playbooks", label: "Playbooks" },
      { href: "/catch-up", label: "Catch Up" },
    ]);
    const utilityItems = await utilities.getByRole("link").evaluateAll((links) => links.map((link) => ({
      href: link.getAttribute("href"),
      label: [...link.children].find((child) => (
        child.tagName === "SPAN" && !child.hasAttribute("data-slot")
      ))?.textContent,
    })));
    expect(utilityItems).toEqual([
      { href: "/members", label: "Team" },
      { href: "/health", label: "Health" },
      { href: "/jobs", label: "Jobs" },
    ]);
    await expect(comingSoon.getByRole("link", { name: "Playbooks Soon" })).toBeVisible();
    await expect(comingSoon.getByRole("link", { name: "Catch Up Soon" })).toBeVisible();

    await projectMemoryDisclosure.click();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(comingSoonDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "true");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(comingSoonDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "false");
  });

  test("opens deep-linked groups, preserves nested aria-current, and marks a collapsed active group", async ({ page }) => {
    await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");
    const projectMemory = page.getByRole("region", { name: "Project Memory" });
    const projectMemoryDisclosure = projectMemory.getByRole("button", { name: "Project Memory" });
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(projectMemory.getByRole("link", { name: "Knowledge", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await projectMemoryDisclosure.click();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(projectMemoryDisclosure).toHaveAttribute("data-active", "true");

    await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
    await expect(page.getByRole("region", { name: "Project Memory" })
      .getByRole("link", { name: "Code", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/jobs?fixture=populated");
    const system = page.getByRole("region", { name: /^System/ });
    await expect(system.getByRole("button", { name: /^System/ })).toHaveAttribute("aria-expanded", "true");
    await expect(system.getByRole("link", { name: "Jobs", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/catch-up?fixture=populated");
    const comingSoon = page.getByRole("region", { name: "Coming Soon" });
    await expect(comingSoon.getByRole("button", { name: "Coming Soon" })).toHaveAttribute("aria-expanded", "true");
    await expect(comingSoon.getByRole("link", { name: "Catch Up Soon" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(
      "A personalized summary of project changes and team activity is planned but is not available in this release.",
      { exact: true },
    )).toBeVisible();
  });

  test("routes the slash launcher to Search, preserves the query, and allows Shift", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.keyboard.press("/");
    await expect(page).toHaveURL(/\/search$/);
    const searchbox = page.getByRole("searchbox", { name: "Search project memory and code" });
    await expect(searchbox).toBeFocused();
    await searchbox.fill("hub");

    await page.locator("#main-content").focus();
    await page.keyboard.press("/");
    await expect(searchbox).toBeFocused();
    await expect(searchbox).toHaveValue("hub");

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.getByRole("link", { name: "Search project", exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(searchbox).not.toBeFocused();

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
      shiftKey: true,
    })));
    await expect(page).toHaveURL(/\/search$/);
    await expect(searchbox).toBeFocused();
  });

  test("suppresses the slash shortcut in editables, dialogs, and with command modifiers", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.evaluate(() => {
      const textarea = document.createElement("textarea");
      textarea.id = "shortcut-textarea";
      const select = document.createElement("select");
      select.id = "shortcut-select";
      select.append(new Option("Option", "option"));
      const editable = document.createElement("div");
      editable.id = "shortcut-contenteditable";
      editable.contentEditable = "true";
      document.body.append(textarea, select, editable);
    });
    for (const id of ["shortcut-textarea", "shortcut-select", "shortcut-contenteditable"] as const) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press("/");
      await expect(page).toHaveURL(/\/\?fixture=populated$/);
    }
    await page.locator("#main-content").focus();
    for (const key of ["Control+/", "Meta+/", "Alt+/"] as const) {
      await page.keyboard.press(key);
      await expect(page).toHaveURL(/\/\?fixture=populated$/);
    }

    await page.goto("/activity?fixture=populated");
    await page.getByRole("button", { name: "Record Activity" }).click();
    const dialog = page.getByRole("dialog", { name: "Record Activity" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await cancel.focus();
    await page.keyboard.press("/");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/activity\?fixture=populated$/);
  });

  test("exposes neutral queue counts, team identity, and exact locality guidance", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    await expect(sidebar.getByLabel("1 proposals awaiting team review.")).toHaveText("1");
    await expect(sidebar.getByLabel("1 open Relays for you.")).toHaveText("1");
    await expect(sidebar.getByLabel("1 active system operations.")).toHaveText("1");
    await expect(sidebar.getByRole("link", { name: "Team", exact: true })).toHaveAttribute("href", "/members");
    await expect(sidebar.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Runs locally", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Shared records use Git", { exact: true })).toBeVisible();
    const locality = sidebar.getByRole("note", { name: "Runs locally. Shared records use Git." });
    const localityExplanation = "MEX runs on this device. Canonical team records are shared when committed and pushed; drafts and indexes remain local to this checkout.";
    await locality.focus();
    await expect(locality).toHaveAccessibleDescription(localityExplanation);
    await expect(page.getByRole("tooltip")).toHaveText(localityExplanation);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    await expectAccessible(page);
  });

  test("keeps both fully expanded and fully collapsed sidebar states accessible", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    const disclosures = {
      projectMemory: page.getByRole("button", { name: "Project Memory" }),
      teamwork: page.getByRole("button", { name: "Teamwork" }),
      comingSoon: page.getByRole("button", { name: "Coming Soon" }),
      system: page.getByRole("button", { name: /^System/ }),
    };
    await disclosures.comingSoon.click();
    await disclosures.system.click();
    for (const disclosure of Object.values(disclosures)) {
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    }
    await expectAccessible(page);

    for (const disclosure of Object.values(disclosures)) await disclosure.click();
    for (const disclosure of Object.values(disclosures)) {
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
    await expectAccessible(page);
  });

  test("captures the populated sidebar with counts and roadmap destinations", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await page.getByRole("button", { name: "Coming Soon" }).click();
    await page.getByRole("button", { name: /^System/ }).click();
    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    await expect(sidebar.getByRole("link", { name: "Catch Up Soon" })).toBeVisible();
    await expect(sidebar.getByLabel("1 active system operations.")).toBeVisible();
    await expect(sidebar).toHaveScreenshot("hub-sidebar-populated.png");
  });

  test("supports keyboard routing, focus restoration, every shell, and 404", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    const routes = [
      [/^Knowledge$/, "Knowledge"],
      [/^Specs$/, "Specs"],
      [/^Code$/, "Code"],
      [/^Workstreams$/, "Workstreams"],
      [/^Inbox(?: |$)/, "Inbox"],
      [/^Relays(?: |$)/, "Relays"],
      [/^Activity$/, "Activity"],
    ] as const;
    for (const [link, heading] of routes) {
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      if (heading === "Knowledge") {
        await expect(page.getByText("All Knowledge records", { exact: true }).locator("..")).toBeFocused();
      } else {
        await expect(page.locator("#main-content")).toBeFocused();
      }
    }

    await page.getByRole("button", { name: "Coming Soon" }).click();
    for (const [link, heading, copy] of [
      ["Playbooks Soon", "Playbooks", "Reusable team workflows are planned but are not available in this release."],
      ["Catch Up Soon", "Catch Up", "A personalized summary of project changes and team activity is planned but is not available in this release."],
    ] as const) {
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText(copy, { exact: true })).toBeVisible();
      await expect(page.locator("#main-content")).toBeFocused();
    }

    await page.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.getByRole("button", { name: /^System/ }).click();
    for (const heading of ["Health", "Jobs"] as const) {
      await page.getByRole("link", { name: heading, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator("#main-content")).toBeFocused();
    }

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/outside-the-workbench?fixture=populated");
    await expect(page.getByText("404", { exact: true })).toBeVisible();
  });

  test("uses the desktop guard at 1023px", async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 800 });
    await page.goto("/?fixture=populated");
    await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 1024, height: 520 },
  ] as const) {
    test(`fits the complete desktop workbench at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/?fixture=populated");
      await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

      const sidebarLocator = page.locator('aside[aria-label="Project Hub navigation"]');
      const navViewport = sidebarLocator.locator('[data-sidebar-scroll="true"]');
      const footer = sidebarLocator.locator("footer");
      const sidebar = await sidebarLocator.boundingBox();
      const scroller = await navViewport.boundingBox();
      const footerBeforeScroll = await footer.boundingBox();
      expect(sidebar?.width).toBe(232);
      expect(sidebar?.x).toBe(0);
      expect(sidebar?.height).toBe(viewport.height);
      expect(scroller).not.toBeNull();
      expect(footerBeforeScroll).not.toBeNull();
      expect(scroller!.y + scroller!.height).toBeLessThanOrEqual(footerBeforeScroll!.y + 1);
      expect(footerBeforeScroll!.y + footerBeforeScroll!.height).toBeLessThanOrEqual(viewport.height + 1);
      await expect(sidebarLocator.getByText("Runs locally", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Coming Soon" }).click();
      await navViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole("link", { name: "Catch Up Soon" })).toBeVisible();
      await expect(sidebarLocator.getByText("Runs locally", { exact: true })).toBeVisible();
      const footerAfterScroll = await footer.boundingBox();
      expect(footerAfterScroll?.y).toBe(footerBeforeScroll?.y);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: viewport.width,
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        bodyScrollWidth: viewport.width,
      });
    });
  }

  test("suppresses computed transitions and animation under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/jobs?fixture=populated");
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();

    const navTransitionDuration = await page.getByRole("link", { name: "Overview", exact: true })
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
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await page.goto("/activity?fixture=populated");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Record Activity" }).click();
    await expect(page.getByRole("dialog", { name: "Record Activity" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/members?fixture=populated");
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await page.goto("/knowledge?fixture=populated");
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Project Hub read boundaries/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    await page.goto("/code?fixture=populated&q=hub");
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await page.getByRole("link", { name: /createHubServer/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
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
    for (const [command, args] of [
      ["git", ["config", "user.name", "MEX Browser Fixture"]],
      ["git", ["config", "user.email", "hub-browser@example.invalid"]],
      ["git", ["add", "--", ".mex"]],
      ["git", ["commit", "--quiet", "--no-gpg-sign", "--message", "browser fixture"]],
    ] as const) {
      const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
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

  test("bootstraps once, stays exact-origin and idle, and never exposes fixture content", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const productionOrigin = new URL(bootstrapUrl).origin;
    const crossOriginRequests: string[] = [];
    const idleApiRequests: string[] = [];
    let observeIdleApi = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== productionOrigin) crossOriginRequests.push(request.url());
      if (observeIdleApi && url.origin === productionOrigin && url.pathname.startsWith("/api/")) {
        idleApiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
      }
    });
    const response = await page.goto(bootstrapUrl);
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect.poll(() => page.url()).not.toContain("#token=");
    await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Code", exact: true })).toBeVisible();
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);

    await page.goto(`${new URL(bootstrapUrl).origin}/?fixture=populated`);
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();

    const [knowledgeUnavailable] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/wiki/entities"),
      page.goto(`${new URL(bootstrapUrl).origin}/knowledge?fixture=populated`),
    ]);
    expect(knowledgeUnavailable.status()).toBe(503);
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByText("Project Hub read boundaries", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Knowledge migration is required" })).toBeVisible();

    await page.goto(`${new URL(bootstrapUrl).origin}/code?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search symbols and source" })).toBeVisible();
    await expect(page.getByText("createHubServer", { exact: true })).toHaveCount(0);

    await page.goto(`${new URL(bootstrapUrl).origin}/activity?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByText("Production real read", { exact: true })).toBeVisible();
    await expect(page.getByText("Production legacy decision", { exact: true })).toBeVisible();
    await expect(page.getByText("Hub activity view connected", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Keep activity immutable and preserve legacy history", { exact: false })).toHaveCount(0);
    await expect(page.getByText("production metadata sentinel", { exact: true })).toHaveCount(0);
    await expect(page.getByText("/private/production/path", { exact: true })).toHaveCount(0);
    await expect(page.getByText(".mex/traces/production-private.md", { exact: true })).toHaveCount(0);
    await page.goto(`${new URL(bootstrapUrl).origin}/members?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("Ada Lovelace", { exact: true })).toHaveCount(0);
    await expect(page.getByText("member_01K36WVM6H7JK8M9NPQRSTVVWX", { exact: true })).toHaveCount(0);
    const [draftsResponse, proposalsResponse] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/inbox/drafts"),
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/inbox/proposals"),
      page.goto(`${productionOrigin}/inbox?fixture=populated`),
    ]);
    expect(draftsResponse.status()).toBe(200);
    expect(proposalsResponse.status()).toBe(200);
    expect(await draftsResponse.json()).toMatchObject({ items: [], nextCursor: null });
    expect(await proposalsResponse.json()).toMatchObject({ items: [], nextCursor: null });
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.locator('[data-inbox-workbench="ready"]')).toBeVisible();

    const [relayDraftsResponse] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/relays/drafts"),
      page.goto(`${productionOrigin}/relays?fixture=populated`),
    ]);
    expect(relayDraftsResponse.status()).toBe(200);
    expect(Object.fromEntries(new URL(relayDraftsResponse.url()).searchParams)).toEqual({ limit: "25" });
    expect(await relayDraftsResponse.json()).toMatchObject({ items: [], nextCursor: null });
    await expect(page.getByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
    await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();
    const relayListResponsePromise = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/api/v1/relays",
    );
    await page.getByRole("tab", { name: "All open" }).click();
    const relayListResponse = await relayListResponsePromise;
    expect(relayListResponse.status()).toBe(200);
    expect(Object.fromEntries(new URL(relayListResponse.url()).searchParams)).toEqual({
      perspective: "all",
      state: "published,acknowledged",
      limit: "25",
    });
    expect(await relayListResponse.json()).toMatchObject({ items: [], nextCursor: null });
    await page.waitForLoadState("networkidle");
    if (!projectRoot) throw new Error("The production Hub fixture root is unavailable.");
    const beforeIdle = snapshotReleaseProtectedState(projectRoot);
    expect(beforeIdle.indexFiles).toEqual([]);
    observeIdleApi = true;
    await page.waitForTimeout(5_500);
    observeIdleApi = false;
    expect(idleApiRequests).toEqual([]);
    expect(snapshotReleaseProtectedState(projectRoot)).toEqual(beforeIdle);
    expect(crossOriginRequests).toEqual([]);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await expectAccessible(page);
    expect(errors).toEqual([
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ]);
  });
});

function snapshotReleaseProtectedState(projectRoot: string): {
  canonical: Record<string, string>;
  gitStatus: string;
  indexFiles: string[];
} {
  const canonicalPaths = [
    ".mex/ROUTER.md",
    ".mex/config.json",
    ".mex/events/activity/2026-08/event_01K3Q080000000000000000004.md",
    ".mex/events/decisions.jsonl",
  ];
  const gitStatus = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (gitStatus.status !== 0) throw new Error(gitStatus.stderr);
  return {
    canonical: Object.fromEntries(canonicalPaths.map((path) => [
      path,
      readFileSync(join(projectRoot, path), "utf8"),
    ])),
    gitStatus: gitStatus.stdout,
    indexFiles: readdirSync(join(projectRoot, ".mex"))
      .filter((name) => name.startsWith("graph.db") || name.startsWith("wiki.db"))
      .sort(),
  };
}

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

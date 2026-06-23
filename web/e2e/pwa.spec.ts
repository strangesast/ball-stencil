/**
 * PWA / offline / persistence e2e. These run against the SAME Playwright
 * project as app.spec.ts, which already serves the **production preview build**
 * (`npm run build && npm run preview` in playwright.config.ts), so a real,
 * production-registered service worker is active here — exactly what we need to
 * exercise offline boot, precache, and the update toast. All service-worker
 * traffic is same-origin (localhost), so the "no external network" contract in
 * app.spec.ts stays green.
 */
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SVG_DIR = join(here, "..", "fixtures", "svg");

type Page = import("@playwright/test").Page;

async function loadSvg(page: Page, name: string) {
  await page.setInputFiles("#file", join(SVG_DIR, name));
}
async function openPanel(page: Page, name: string) {
  const chip = page.locator(`[data-panel="${name}"]`);
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
}
async function expandParamGroups(page: Page) {
  await openPanel(page, "params");
  await page
    .locator("#panel-params .group.collapsed .group-head")
    .evaluateAll((els) => els.forEach((e) => (e as HTMLElement).click()));
}

test("first run builds the bundled sample letter (no upload needed)", async ({ page }) => {
  await page.goto("/");
  // A brand-new visitor immediately sees a finished stencil, not an empty prompt.
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  // The artwork is labelled a sample, not the user's own data.
  await openPanel(page, "artwork");
  await expect(page.locator("#svginfo")).toContainText("sample");
  // The built default enables the download buttons.
  await openPanel(page, "downloads");
  await expect(page.locator("#dl-stl")).toBeEnabled();
});

test("favicon is served (no 404)", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.get("/favicon.ico");
  expect(res.status()).toBe(200);
});

test("persists and restores SVG + params + panel state across reload", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  await expandParamGroups(page);
  await page.fill("#p-wall_thickness_mm", "4");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  // Reload: the last SVG, params and open-panel state should restore and the
  // stencil should rebuild automatically (no re-pick of the file).
  await page.reload();
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  // Parameters panel was open → restored open; its value persisted.
  await expect(page.locator("#panel-params")).toBeVisible();
  expect(await page.inputValue("#p-wall_thickness_mm")).toBe("4");
});

test("works fully offline: boots from cache, builds and exports with no network", async ({ page, context }) => {
  await page.goto("/");
  // Wait until the service worker is active (precache completes during install,
  // before activation, so a resolved `ready` implies the shell is cached).
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  await page.reload(); // navigation served by the SW from cache
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // Cold offline launch still builds the default sample letter: the opentype
  // chunk and the bundled font are precached, so no network is needed.
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  await openPanel(page, "artwork");
  await expect(page.locator("#svginfo")).toContainText("sample");

  // And a fresh letter can be generated offline too.
  await page.fill("#letter", "S");
  await page.click("#letter-go");
  await expect(page.locator("#svginfo")).not.toContainText("sample", { timeout: 40000 });
  await expect(page.locator("#badge")).toHaveText("PASS");

  // Loading an SVG is a local file read; the build uses the precached lazy
  // worker/pipeline chunk — all with the network disabled.
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  // A full STL export must also succeed offline.
  await openPanel(page, "downloads");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#dl-stl")]);
  const stream = await download.createReadStream();
  let len = 0;
  for await (const chunk of stream) len += (chunk as Buffer).length;
  expect(len).toBeGreaterThan(84);

  await context.setOffline(false);
});

test("update toast appears on a new SW and the Reload action is wired", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => ((window as any).__pwaNoReload = true)); // assert wiring, skip real reload
  // Drive the real onNeedRefresh code path the plugin calls when a new SW waits.
  await page.evaluate(() => (window as any).__pwa.needRefresh());

  const toast = page.locator(".toast").filter({ hasText: "Update available" });
  await expect(toast).toBeVisible();
  const reload = toast.getByRole("button", { name: "Reload" });
  await expect(reload).toBeVisible();
  await reload.click();
  expect(await page.evaluate(() => (window as any).__pwaUpdateCalled === true)).toBe(true);
});

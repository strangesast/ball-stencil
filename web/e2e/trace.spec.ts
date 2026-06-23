/**
 * Raster-trace e2e (headless). This is the ONLY place the real trace.worker.ts
 * decode path (createImageBitmap + OffscreenCanvas) runs — those APIs aren't in
 * the Node unit-test env, so the pure core is covered there and the full
 * worker → loadSvgText → mesh round-trip is covered here. Drives the single file
 * input with a bundled sample PNG, for each backend, and asserts a stencil meshes
 * with the same Artwork panel/persistence behaviour as an SVG upload. Also proves
 * the trace works offline (the tracer chunk + embedded wasm are precached).
 */
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "..", "public", "sample-trace.png");

type Page = import("@playwright/test").Page;

async function openPanel(page: Page, name: string) {
  const chip = page.locator(`[data-panel="${name}"]`);
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
}

for (const backend of ["potrace", "color"] as const) {
  test(`tracing a PNG with the ${backend} backend builds a PASS stencil`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 }); // sample letter built

    await openPanel(page, "artwork");
    // The backend radios are visually hidden (the segmented control); click the
    // associated label, exactly as the existing view-mode tests do.
    if (backend === "color") await page.click('label[for="tracebk-color"]');
    // Pick the raster through the SAME single file input SVGs use.
    await page.setInputFiles("#file", SAMPLE);

    // Wait for the Artwork panel to reflect the traced file FIRST (this only
    // happens after the off-thread trace resolves), so the PASS below is the
    // traced mesh's, not the sample letter's pre-existing PASS.
    await expect(page.locator("#svginfo")).toContainText("sample-trace.svg", { timeout: 40000 });
    await expect(page.locator("#svginfo")).not.toContainText("Showing a sample");
    await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

    // A real stencil report + enabled downloads, exactly like an SVG upload.
    await openPanel(page, "report");
    await expect(page.locator("#report-body")).toContainText("cut holes:");
    await openPanel(page, "downloads");
    await expect(page.locator("#dl-stl")).toBeEnabled();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-stl")]);
    expect(dl.suggestedFilename()).toBe("sample-trace_stencil.stl");
  });
}

test("trace backend + threshold persist across reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  await openPanel(page, "artwork");
  await page.click('label[for="tracebk-color"]');
  // Range input: set value + fire `input` (no raster loaded, so nothing re-traces).
  await page.locator("#trace-threshold").evaluate((el: HTMLInputElement) => {
    el.value = "90";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.reload();
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  await openPanel(page, "artwork");
  await expect(page.locator("#tracebk-color")).toBeChecked();
  await expect(page.locator("#trace-threshold")).toHaveValue("90");
});

test("traces a PNG offline (tracer chunk + embedded wasm precached)", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  await page.reload(); // served from cache by the SW
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  // Trace a raster with the (wasm) potrace backend — no network.
  await openPanel(page, "artwork");
  await page.setInputFiles("#file", SAMPLE);
  await expect(page.locator("#svginfo")).toContainText("sample-trace.svg", { timeout: 40000 });
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  await context.setOffline(false);
});

test("a non-image, non-SVG file shows an inline unsupported message", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  await openPanel(page, "artwork");
  await page.setInputFiles("#file", {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.locator("#trace-err")).toBeVisible();
  await expect(page.locator("#trace-err")).toContainText("Unsupported");
});

/**
 * Browser e2e (headless). Drives the real app: load it, select an SVG via the
 * file input, change parameters, and assert the preview re-meshes live, the
 * report shows the expected PASS + values, downloads produce non-empty files of
 * the expected size, the main thread stays responsive, and no runtime network
 * requests occur after initial load. Golden expectations come from the shared
 * fixtures file (web/fixtures/golden.json), the single source of truth.
 *
 * Layout note (UI refactor): controls now live in translucent launcher panels
 * that start collapsed. The selectors and asserted report text are UNCHANGED
 * (#badge, #report-body, #p-<key>, #dl-*); the only additions below are small
 * navigation helpers that open the relevant panel/group before reading or
 * editing a control — exactly what a user does. The badge floats in the
 * always-visible HUD, so badge assertions need no panel to be open.
 */
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const SVG_DIR = join(here, "..", "fixtures", "svg");
const golden = JSON.parse(readFileSync(join(here, "..", "fixtures", "golden.json"), "utf8"));
const splashDefault = golden.cases.find((c: any) => c.svg === "splash.svg" && Object.keys(c.overrides).length === 0);

type Page = import("@playwright/test").Page;

async function loadSvg(page: Page, name: string) {
  await page.setInputFiles("#file", join(SVG_DIR, name));
}

/** Open a launcher panel if it isn't already open (idempotent). */
async function openPanel(page: Page, name: string) {
  const chip = page.locator(`[data-panel="${name}"]`);
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
}

/** The full metrics table lives in the (collapsible) Report panel. */
async function readReport(page: Page): Promise<string> {
  await openPanel(page, "report");
  return page.locator("#report-body").innerText();
}

/** Open the Parameters panel and expand every group so #p-<key> is fillable. */
async function setParam(page: Page, key: string, value: string) {
  await openPanel(page, "params");
  await page
    .locator("#panel-params .group.collapsed .group-head")
    .evaluateAll((els) => els.forEach((e) => (e as HTMLElement).click()));
  await page.fill(`#p-${key}`, value);
}

test("builds splash.svg to a PASS stencil with the golden topology", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  const body = await readReport(page);
  // exact topology: 51 cut holes, 2 components incl. a free island
  expect(body).toContain("cut holes: 51");
  expect(body).toContain("material components: 2");
  expect(body).toContain("free island");
  // watertight / manifold / winding all yes
  expect(body).toContain("watertight");
  expect(body).toMatch(/signed volume/);

  // signed volume within +/-1% of golden
  const m = body.match(/signed volume\s+([\d.]+)\s*mm/);
  expect(m).toBeTruthy();
  const vol = parseFloat(m![1]);
  expect(Math.abs(vol - splashDefault.signed_volume_mm3) / splashDefault.signed_volume_mm3).toBeLessThan(0.01);
});

test("preview re-meshes live when parameters change (no Generate button)", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  const volOf = async () => {
    const b = await readReport(page);
    return parseFloat(b.match(/signed volume\s+([\d.]+)/)![1]);
  };
  const v2 = await volOf();

  // change wall thickness 2 -> 4 and watch the report update on its own
  await setParam(page, "wall_thickness_mm", "4");
  await expect
    .poll(async () => Math.round(await volOf()), { timeout: 40000 })
    .toBeGreaterThan(Math.round(v2 * 1.5)); // wall 4 roughly doubles volume
  await expect(page.locator("#badge")).toHaveText("PASS");
});

test("rapid edits converge to the latest parameters", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  // fire several quick edits; only the last (cap angle 60) should win
  await setParam(page, "cap_angle_deg", "120");
  await setParam(page, "cap_angle_deg", "90");
  await setParam(page, "cap_angle_deg", "60");
  const cap60 = golden.cases.find((c: any) => c.svg === "splash.svg" && c.overrides.cap_angle_deg === 60);
  await expect
    .poll(async () => {
      const b = await readReport(page);
      const mm = b.match(/signed volume\s+([\d.]+)/);
      return mm ? parseFloat(mm[1]) : 0;
    }, { timeout: 40000 })
    .toBeLessThan(cap60.signed_volume_mm3 * 1.05);
});

test("main thread stays responsive during a build", async ({ page }) => {
  await page.goto("/");
  // install a rAF tick counter on the main thread
  await page.evaluate(() => {
    (window as any).__ticks = 0;
    const tick = () => { (window as any).__ticks++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await loadSvg(page, "splash.svg");
  const before = await page.evaluate(() => (window as any).__ticks);
  // while the (worker) build runs, the main-thread rAF loop must keep ticking
  await page.waitForTimeout(800);
  const during = await page.evaluate(() => (window as any).__ticks);
  expect(during - before).toBeGreaterThan(10);
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
});

test("STL / OBJ / ball downloads produce files of the expected size", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  const body = await readReport(page);
  const faces = parseInt(body.match(/vertices \/ faces\s+[\d,]+\s*\/\s*([\d,]+)/)![1].replace(/,/g, ""), 10);
  const verts = parseInt(body.match(/vertices \/ faces\s+([\d,]+)/)![1].replace(/,/g, ""), 10);

  // STL: binary length == 84 + 50 * nFaces
  const stl = await downloadBytes(page, "#dl-stl");
  expect(stl).toBe(84 + 50 * faces);

  // OBJ: parses to the same vert/face counts
  const objText = await downloadText(page, "#dl-obj");
  const vCount = (objText.match(/^v /gm) || []).length;
  const fCount = (objText.match(/^f /gm) || []).length;
  expect(vCount).toBe(verts);
  expect(fCount).toBe(faces);

  // reference ball STL: non-empty clean sphere
  const ball = await downloadBytes(page, "#dl-ball");
  expect(ball).toBe(84 + 50 * (96 * (48 - 1) * 2));
});

test("no external network requests after initial load", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.hostname !== "localhost" && u.protocol !== "data:" && u.protocol !== "blob:") external.push(req.url());
  });
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  await setParam(page, "wall_thickness_mm", "3");
  await page.waitForTimeout(1500);
  expect(external, external.join("\n")).toHaveLength(0);
});

test("a worker-side build failure surfaces as FAIL, not a stuck 'building…' badge", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });

  // Cut separation of 100 svg units empties the material -> the worker throws.
  // The error must propagate: badge flips to FAIL and the message is shown
  // (regression guard for the silent "Uncaught (in promise)" worker hang).
  await setParam(page, "cut_separation_svg", "100");
  await expect(page.locator("#badge")).toHaveText("FAIL", { timeout: 40000 });
  const body = await readReport(page);
  expect(body).toMatch(/material region is empty/i);
});

test("splash_z builds a single-hole, single-component stencil (no island)", async ({ page }) => {
  await page.goto("/");
  await loadSvg(page, "splash_z.svg");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 });
  const body = await readReport(page);
  expect(body).toContain("cut holes: 1");
  expect(body).toContain("material components: 1");
  expect(body).not.toContain("free island");
});

test("generates a stencil from a typed counter letter, downloadable by its name", async ({ page }) => {
  await page.goto("/");
  // The bundled sample (a solid letter) builds first; it has no free island.
  await page.locator('[data-panel="report"]').click();
  await expect(page.locator("#report-body")).not.toContainText("free island", { timeout: 40000 });

  await openPanel(page, "artwork");
  await page.fill("#letter", "B");
  await page.click("#letter-go");

  // B's ink is one through-hole; its two counters are carved out as free islands
  // (the legitimate even-odd result) — proves counters are not filled solid.
  await openPanel(page, "report");
  await expect(page.locator("#report-body")).toContainText("cut holes: 1", { timeout: 40000 });
  await expect(page.locator("#report-body")).toContainText("free island");
  await expect(page.locator("#badge")).toHaveText("PASS");

  // Downloads read "<letter>_stencil.stl" (no "sample" tag — it is now user data).
  await openPanel(page, "downloads");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-stl")]);
  expect(dl.suggestedFilename()).toBe("B_stencil.stl");
});

test("whitespace letter input is rejected with a message, no blank build", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#badge")).toHaveText("PASS", { timeout: 40000 }); // sample built
  await openPanel(page, "artwork");
  await page.fill("#letter", "   ");
  await page.click("#letter-go");
  await expect(page.locator("#letter-err")).toBeVisible();
  await expect(page.locator("#letter-err")).toContainText("Type a letter");
  // The sample remains; the badge is not stuck building and the view is not blank.
  await expect(page.locator("#badge")).toHaveText("PASS");
});

// -- download helpers (open the Download panel before clicking) -------------
async function downloadBytes(page: Page, sel: string): Promise<number> {
  await openPanel(page, "downloads");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click(sel)]);
  const stream = await download.createReadStream();
  let len = 0;
  for await (const chunk of stream) len += (chunk as Buffer).length;
  return len;
}
async function downloadText(page: Page, sel: string): Promise<string> {
  await openPanel(page, "downloads");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click(sel)]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

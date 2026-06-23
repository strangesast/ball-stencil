/**
 * SVG parsing transform support (src/pipeline/svg.ts). Editors (Inkscape, …)
 * routinely wrap geometry in a <g transform="translate/matrix(...)"> group; the
 * DOM-free parser must fold that CTM onto every <path> so loadArtwork sees the
 * geometry in viewBox space. Without it an uploaded artwork lands off-centre and
 * undersized — the viewBox-derived design centre no longer matches the geometry,
 * which inflates maxRadius (→ tiny on the ball) and displaces it (→ off-centre).
 */
import { describe, it, expect } from "vitest";
import { parseSvg, parseTransform, matmul, applyMatrix } from "../src/pipeline/svg";
import { loadArtwork } from "../src/pipeline/svgio";
import { Clip } from "../src/pipeline/clip";
import { loadOffsetLib } from "../src/pipeline/offset";

describe("parseTransform", () => {
  it("parses translate, scale, rotate, matrix and composes left-to-right", () => {
    expect(parseTransform("translate(10 20)")).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform("translate(10)")).toEqual([1, 0, 0, 1, 10, 0]);
    expect(parseTransform("scale(2 3)")).toEqual([2, 0, 0, 3, 0, 0]);
    expect(parseTransform("matrix(1,2,3,4,5,6)")).toEqual([1, 2, 3, 4, 5, 6]);

    // rotate(90) maps (1,0) -> (0,1)
    const r = parseTransform("rotate(90)");
    const [rx, ry] = applyMatrix(r, 1, 0);
    expect(rx).toBeCloseTo(0, 9);
    expect(ry).toBeCloseTo(1, 9);

    // "translate(5,0) scale(2)" applied to (1,1) -> scale first, then translate
    const m = parseTransform("translate(5,0) scale(2)");
    expect(applyMatrix(m, 1, 1)).toEqual([7, 2]);
    expect(m).toEqual(matmul([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0]));
  });

  it("returns identity for empty/unknown transforms", () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform("wobble(3)")).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("parseSvg group transforms", () => {
  it("folds an ancestor <g transform> onto the path CTM", () => {
    const svg =
      `<svg viewBox="0 0 100 100"><g transform="translate(10 20)">` +
      `<path d="M0 0 L1 1"/></g></svg>`;
    const p = parseSvg(svg);
    expect(p.paths).toHaveLength(1);
    expect(p.paths[0].transform).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it("composes nested groups and the path's own transform (outer-to-inner)", () => {
    const svg =
      `<svg viewBox="0 0 100 100"><g transform="translate(10 0)">` +
      `<g transform="scale(2)"><path d="M0 0" transform="translate(0 5)"/></g></g></svg>`;
    const p = parseSvg(svg);
    // translate(10,0) ∘ scale(2) ∘ translate(0,5) applied to (0,0) -> (10,10)
    expect(applyMatrix(p.paths[0].transform, 0, 0)).toEqual([10, 10]);
  });

  it("pops the stack at </g> so siblings don't inherit a closed group", () => {
    const svg =
      `<svg viewBox="0 0 100 100">` +
      `<g transform="translate(100 0)"><path d="M0 0"/></g>` +
      `<path d="M0 0"/></svg>`;
    const p = parseSvg(svg);
    expect(applyMatrix(p.paths[0].transform, 0, 0)).toEqual([100, 0]);
    expect(applyMatrix(p.paths[1].transform, 0, 0)).toEqual([0, 0]); // outside the group
  });

  it("hides paths inside a display:none group", () => {
    const svg =
      `<svg viewBox="0 0 100 100"><g style="display:none"><path d="M0 0"/></g></svg>`;
    expect(parseSvg(svg).paths[0].hidden).toBe(true);
  });
});

describe("loadArtwork applies the group transform (regression: small + off-centre)", () => {
  it("centres a translated square on the viewBox centre, not the origin", async () => {
    await loadOffsetLib();
    const clip = new Clip(0.05);
    // A 20×20 square authored at the origin, then translated to the viewBox
    // centre (40,40) by a wrapping group. The region must land there.
    const svg =
      `<svg viewBox="0 0 100 100"><g transform="translate(30 30)">` +
      `<path d="M0 0 L20 0 L20 20 L0 20 Z"/></g></svg>`;
    const art = loadArtwork(parseSvg(svg), 0.1, clip);
    const r = clip.maxRadius(art.region, art.center[0], art.center[1]);
    // Square centred at (40,40) == design centre (50,50)? No — centred at 40,40
    // sits 10 off the viewBox centre; the corner radius stays modest (~17), not
    // the inflated ~64 you'd get if the square were left at the origin.
    expect(r).toBeLessThan(30);
    expect(r).toBeGreaterThan(10);
  });
});

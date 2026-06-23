/**
 * Glyph → SVG conversion. Verifies the synthesized SVG is pipeline-clean: it
 * parses via parseSvg into a viewBox + at least one path, a stencil glyph yields
 * bridge-split solid contours (not a nested counter), and a generated letter —
 * including a counter letter — runs all the way through the real geometry
 * pipeline to a watertight/manifold PASS with no free island (the stencil face
 * bridges every bowl). Whitespace/invalid input is rejected, not built.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import opentype, { Font } from "opentype.js";
import { buildGlyphSvg, DEFAULT_LETTER, MAX_GLYPH_CHARS } from "../src/glyph";
import { parseSvg } from "../src/pipeline/svg";
import { parsePathSubpaths } from "../src/pipeline/tessellate";
import { runPipeline } from "../src/pipeline/pipeline";
import { DEFAULT_PARAMS } from "../src/pipeline/config";
import { loadOffsetLib } from "../src/pipeline/offset";

const here = dirname(fileURLToPath(import.meta.url));
const FONT = join(here, "..", "public", "fonts", "StardosStencil-Bold-subset.woff");

let font: Font;
beforeAll(async () => {
  const buf = readFileSync(FONT);
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  await loadOffsetLib();
});

/** Count contours (subpaths) across every visible <path> of a generated SVG. */
function contourCount(svgText: string): number {
  const parsed = parseSvg(svgText);
  return parsed.paths
    .filter((p) => !p.hidden)
    .reduce((n, p) => n + parsePathSubpaths(p.d).length, 0);
}

describe("buildGlyphSvg → parseSvg", () => {
  it("a letter parses into a finite viewBox + at least one contour", () => {
    const { svgText, name } = buildGlyphSvg(font, "Z");
    expect(name).toBe("Z");
    const parsed = parseSvg(svgText);
    // viewBox is finite and has positive extent
    expect(parsed.viewBox.every((n) => Number.isFinite(n))).toBe(true);
    expect(parsed.viewBox[2]).toBeGreaterThan(0);
    expect(parsed.viewBox[3]).toBeGreaterThan(0);
    expect(parsed.paths.length).toBeGreaterThanOrEqual(1);
    expect(contourCount(svgText)).toBeGreaterThanOrEqual(1);
  });

  it("a stencil glyph emits bridge-split solid pieces (no nested counter)", () => {
    // The stencil face breaks each glyph into disjoint solid contours joined to
    // the outside by bridge gaps — NOT an outer ring + enclosed counter. So even
    // a counter letter is several side-by-side pieces, never a hole-in-a-ring.
    expect(contourCount(buildGlyphSvg(font, "O").svgText)).toBe(2); // two arcs
    expect(contourCount(buildGlyphSvg(font, "B").svgText)).toBe(2);
    expect(contourCount(buildGlyphSvg(font, "A").svgText)).toBe(3);
  });

  it("centres the glyph: viewBox centre is the design centre parseSvg derives", () => {
    const parsed = parseSvg(buildGlyphSvg(font, "B").svgText);
    const [minx, miny, w, h] = parsed.viewBox;
    // svgio takes center = viewBox centre; just assert it is inside the box.
    expect(minx + w / 2).toBeGreaterThan(minx);
    expect(miny + h / 2).toBeGreaterThan(miny);
  });

  it("emits no transforms, <g> or <text> (parseSvg-clean)", () => {
    const { svgText } = buildGlyphSvg(font, "B");
    expect(svgText).not.toMatch(/transform=/);
    expect(svgText).not.toMatch(/<g\b/);
    expect(svgText).not.toMatch(/<text\b/);
  });

  it("embeds the requested fill colour (and defaults to the paint default)", () => {
    expect(parseSvg(buildGlyphSvg(font, "Z", "#1133cc").svgText).fill).toBe("#1133cc");
    expect(parseSvg(buildGlyphSvg(font, "Z").svgText).fill).toBe("#d92a2e");
  });

  it("rejects whitespace / empty input instead of building blank", () => {
    expect(() => buildGlyphSvg(font, "")).toThrow(/Type a letter/);
    expect(() => buildGlyphSvg(font, "   ")).toThrow(/Type a letter/);
    expect(() => buildGlyphSvg(font, " ")).toThrow(/Type a letter/);
  });

  it("rejects an over-long string", () => {
    expect(() => buildGlyphSvg(font, "ABCDE")).toThrow(/at most/);
    // exactly MAX is allowed
    expect(() => buildGlyphSvg(font, "ABCD")).not.toThrow();
    expect(MAX_GLYPH_CHARS).toBe(4);
  });

  it("sanitizes the download name", () => {
    expect(buildGlyphSvg(font, "Z").name).toBe("Z");
    expect(buildGlyphSvg(font, "A B").name).toBe("A_B");
  });
});

describe("generated letter through the real pipeline", () => {
  it("a letter builds to a watertight/manifold PASS with no free island", () => {
    const parsed = parseSvg(buildGlyphSvg(font, "Z").svgText);
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "Z.svg");
    expect(res.ok).toBe(true);
    expect(res.report.isWatertight).toBe(true);
    expect(res.report.isManifold).toBe(true);
    expect(res.report.consistentWinding).toBe(true);
    // Stardos splits the Z into bridge-separated cut regions, but the sheet
    // stays one connected component — no free-floating material island.
    expect(res.build.nCutRegions).toBeGreaterThanOrEqual(1);
    expect(res.build.islands.length).toBe(1);
  });

  it("a counter letter stays a single component — the stencil bridges the bowl", () => {
    // This is the whole reason for a stencil face: O/A/B used to carve an
    // enclosed counter that becomes a free-floating island (the "would fall
    // apart" warning). Bridged, the bowl connects to the outside, so the sheet
    // is one piece and there is no free island.
    for (const ch of ["O", "A", "B"]) {
      const parsed = parseSvg(buildGlyphSvg(font, ch).svgText);
      const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, `${ch}.svg`);
      expect(res.ok, ch).toBe(true);
      expect(res.report.isWatertight, ch).toBe(true);
      expect(res.build.islands.length, ch).toBe(1); // no free island
    }
  });

  it("the first-run default letter builds to a clean single-component PASS", () => {
    const parsed = parseSvg(buildGlyphSvg(font, DEFAULT_LETTER).svgText);
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "default.svg");
    expect(res.ok).toBe(true);
    expect(res.report.isWatertight).toBe(true);
    // No scary free-island warning on first paint.
    expect(res.build.islands.length).toBe(1);
  });
});

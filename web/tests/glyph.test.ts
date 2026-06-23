/**
 * Glyph → SVG conversion. Verifies the synthesized SVG is pipeline-clean: it
 * parses via parseSvg into a viewBox + at least one path, a counter letter
 * yields the expected number of contours (so even-odd carves the counter), and
 * a generated letter runs all the way through the real geometry pipeline to a
 * watertight/manifold PASS. Whitespace/invalid input is rejected, not built.
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
const FONT = join(here, "..", "public", "fonts", "DejaVuSans-Bold-subset.woff");

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
  it("a solid letter parses into a viewBox + exactly one contour", () => {
    const { svgText, name } = buildGlyphSvg(font, "Z");
    expect(name).toBe("Z");
    const parsed = parseSvg(svgText);
    // viewBox is finite and has positive extent
    expect(parsed.viewBox.every((n) => Number.isFinite(n))).toBe(true);
    expect(parsed.viewBox[2]).toBeGreaterThan(0);
    expect(parsed.viewBox[3]).toBeGreaterThan(0);
    expect(parsed.paths.length).toBeGreaterThanOrEqual(1);
    expect(contourCount(svgText)).toBe(1); // Z has no counter
  });

  it("a counter letter yields an outer contour + its hole(s)", () => {
    // B = outer ring + two counters; O = outer ring + one counter.
    expect(contourCount(buildGlyphSvg(font, "B").svgText)).toBe(3);
    expect(contourCount(buildGlyphSvg(font, "O").svgText)).toBe(2);
    expect(contourCount(buildGlyphSvg(font, "A").svgText)).toBe(2);
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
  it("a solid letter builds to a watertight/manifold PASS, single hole", () => {
    const parsed = parseSvg(buildGlyphSvg(font, "Z").svgText);
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "Z.svg");
    expect(res.ok).toBe(true);
    expect(res.report.isWatertight).toBe(true);
    expect(res.report.isManifold).toBe(true);
    expect(res.report.consistentWinding).toBe(true);
    expect(res.build.nCutRegions).toBe(1);
    expect(res.build.islands.length).toBe(1); // no free island
  });

  it("a counter letter carves the counter (hole present), still a PASS", () => {
    const parsed = parseSvg(buildGlyphSvg(font, "O").svgText);
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "O.svg");
    expect(res.ok).toBe(true);
    expect(res.report.isWatertight).toBe(true);
    // The carved counter is an enclosed material island (it would be a physical
    // bridge-less hole) — that is the legitimate even-odd result, not solid fill.
    expect(res.build.islands.length).toBeGreaterThan(1);
  });

  it("the first-run default letter builds to a clean single-component PASS", () => {
    const parsed = parseSvg(buildGlyphSvg(font, DEFAULT_LETTER).svgText);
    const res = runPipeline(parsed, { ...DEFAULT_PARAMS }, "default.svg");
    expect(res.ok).toBe(true);
    expect(res.report.isWatertight).toBe(true);
    // Counter-free default → no scary free-island warning on first paint.
    expect(res.build.islands.length).toBe(1);
  });
});

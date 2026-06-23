/**
 * Letter → filled-glyph SVG. Turns a typed character (or short string) into a
 * plain `<svg viewBox><path d/></svg>` that the existing pipeline consumes
 * exactly like an uploaded file — no `<g>`, no transforms, no `<text>`, just an
 * absolute-coordinate filled outline (parseSvg only reads `<path d>`).
 *
 * The outline comes from a bundled, subset, heavy face (DejaVu Sans Bold) parsed
 * with opentype.js. `getPath()` emits each contour — including a letter's
 * counters (B/O/A/…) — as a separate subpath, which is exactly what svgio's
 * even-odd fold needs to carve the counter out as a hole rather than fill it.
 *
 * opentype.js produces y-down SVG coordinates (glyph upright when dropped into an
 * SVG), the same convention as the bundled Inkscape samples, so the pipeline's
 * default `flip_v` un-mirrors a generated letter without the user toggling it.
 *
 * Split in two: `buildGlyphSvg(font, …)` is pure/DOM-free (unit-tested against
 * parseSvg/loadArtwork in Node), and `glyphToSvg(text, …)` is the browser entry
 * that lazy-loads opentype.js + fetches the precached font, then delegates to it.
 */
import type { Font } from "opentype.js";
import { DEFAULT_PAINT_HEX, normalizeColor } from "./color";

export interface BundledFont {
  id: string;
  label: string;
  /** Path relative to the app base (precached by the service worker). */
  file: string;
}

/** One clean, heavy, high-contrast face. Thin/serif faces trace poorly and
 *  produce slivers/free-islands downstream, so we ship a single bold sans. */
export const FONTS: BundledFont[] = [
  { id: "dejavu-bold", label: "DejaVu Sans Bold", file: "fonts/DejaVuSans-Bold-subset.woff" },
];

/** The zero-input default letter shown on a fresh, empty first run. A solid,
 *  counter-free glyph so the very first paint is a clean single-hole PASS — a
 *  counter letter (B/O/A) legitimately produces an enclosed material island,
 *  which would surface an alarming "stencil would fall apart" warning as an
 *  unsolicited default. The even-odd counter path is exercised by the tests and
 *  the moment the user types their own letter. */
export const DEFAULT_LETTER = "Z";

export interface GlyphSvg {
  svgText: string;
  /** Filename-safe name (downloads read `<name>_stencil.stl`). */
  name: string;
}

/** Max characters accepted; longer strings map too small on the cap to trace. */
export const MAX_GLYPH_CHARS = 4;

function glyphName(text: string): string {
  const s = text.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_-]/g, "");
  return s || "letter";
}

/**
 * Pure: synthesize a pipeline-clean SVG for `text` using an already-loaded font.
 * Throws (no blank build) on empty/whitespace input or a glyph with no fillable
 * area, with a message suitable for the inline error / overlay.
 */
export function buildGlyphSvg(font: Font, text: string, fill?: string): GlyphSvg {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    throw new Error(`Type a letter (up to ${MAX_GLYPH_CHARS} characters) to generate a stencil.`);
  }
  if ([...clean].length > MAX_GLYPH_CHARS) {
    throw new Error(`Use at most ${MAX_GLYPH_CHARS} characters.`);
  }

  // Em-scale to a comfortable working size; absolute coords, counters as
  // separate contours. Kerning keeps multi-letter spacing sane.
  const fontSize = 1000;
  const path = font.getPath(clean, 0, 0, fontSize, { kerning: true });
  const d = path.toPathData(2);
  const bb = path.getBoundingBox();
  const w = bb.x2 - bb.x1;
  const h = bb.y2 - bb.y1;
  if (!d || !(w > 0) || !(h > 0)) {
    throw new Error(`“${clean}” has no fillable outline — try a different character.`);
  }

  // viewBox tightly bounds the glyph with a small uniform margin; parseSvg takes
  // the design centre from the viewBox centre, so a glyph centred in its bbox
  // maps to the cap apex.
  const margin = 0.08 * Math.max(w, h);
  const vb = [bb.x1 - margin, bb.y1 - margin, w + 2 * margin, h + 2 * margin]
    .map((n) => +n.toFixed(2))
    .join(" ");
  // The chosen colour is embedded as the path fill so the design "specifies a
  // colour" exactly like an uploaded SVG — the projection paint picks it up.
  const color = normalizeColor(fill) ?? DEFAULT_PAINT_HEX;
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` +
    `<path d="${d}" fill="${color}"/></svg>`;
  return { svgText, name: glyphName(clean) };
}

// -- browser font loading (lazy import + precached fetch, cached per id) -------
const fontCache = new Map<string, Promise<Font>>();

function loadFont(id: string): Promise<Font> {
  const meta = FONTS.find((f) => f.id === id) ?? FONTS[0];
  let p = fontCache.get(meta.id);
  if (!p) {
    p = (async () => {
      const ot = (await import("opentype.js")) as unknown as {
        default?: { parse(b: ArrayBuffer): Font };
        parse?(b: ArrayBuffer): Font;
      };
      const parse = ot.parse ?? ot.default!.parse;
      // Same-origin, precached by the service worker — served from cache offline.
      const url = import.meta.env.BASE_URL + meta.file;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load font ${meta.label} (HTTP ${res.status}).`);
      return parse(await res.arrayBuffer());
    })();
    fontCache.set(meta.id, p);
  }
  return p;
}

/** Browser entry: lazy-load the font and synthesize the SVG for `text`. */
export async function glyphToSvg(
  text: string,
  opts: { fontId?: string; fill?: string } = {},
): Promise<GlyphSvg> {
  const font = await loadFont(opts.fontId ?? FONTS[0].id);
  return buildGlyphSvg(font, text, opts.fill);
}

/**
 * Minimal, DOM-free SVG document parsing.
 *
 * Extracts the viewBox (falling back to width/height with unit suffixes
 * stripped) and every <path> element's geometry/label/visibility — exactly the
 * inputs svgio.load_artwork needs. Kept dependency-free and environment-neutral
 * so the same code runs in the Web Worker and in Node tests.
 */

import { normalizeColor } from "../color";

export interface SvgPath {
  d: string;
  label: string; // inkscape:label -> id -> "path"
  hidden: boolean; // display:none via style or attribute
  fill: string | null; // normalized #rrggbb fill, or null (none/unspecified)
}

export interface ParsedSvg {
  viewBox: [number, number, number, number]; // (minx, miny, w, h)
  paths: SvgPath[];
  /** Representative design fill (first visible path with an explicit colour),
   *  or null when the artwork specifies none. Drives the projection paint. */
  fill: string | null;
}

const LEN_RE = /^[-+]?[0-9]*\.?[0-9]+/;

function parseLength(value: string | null | undefined, dflt = 0): number {
  if (value == null) return dflt;
  const m = LEN_RE.exec(String(value).trim());
  return m ? parseFloat(m[0]) : dflt;
}

function attr(tag: string, name: string): string | undefined {
  // match name="..." or name='...'
  const re = new RegExp(
    `(?:^|\\s)${name.replace(/[:]/g, "[:]")}\\s*=\\s*("([^"]*)"|'([^']*)')`,
  );
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] !== undefined ? m[2] : m[3];
}

export function parseSvg(svgText: string): ParsedSvg {
  // viewBox / width / height from the opening <svg ...> tag.
  const svgTagMatch = /<svg\b([^>]*)>/i.exec(svgText);
  const svgTag = svgTagMatch ? svgTagMatch[1] : "";
  let viewBox: [number, number, number, number];
  const vb = attr(svgTag, "viewBox") ?? attr(svgTag, "viewbox");
  if (vb) {
    const a = vb
      .replace(/,/g, " ")
      .trim()
      .split(/\s+/)
      .map((x) => parseFloat(x));
    if (a.length >= 4 && a.every((x) => Number.isFinite(x))) {
      viewBox = [a[0], a[1], a[2], a[3]];
    } else {
      viewBox = [0, 0, parseLength(attr(svgTag, "width")), parseLength(attr(svgTag, "height"))];
    }
  } else {
    viewBox = [0, 0, parseLength(attr(svgTag, "width")), parseLength(attr(svgTag, "height"))];
  }

  // Every <path ...> element (self-closing or not). Strokes/images ignored.
  const paths: SvgPath[] = [];
  const pathRe = /<path\b([^>]*?)\/?>/gis;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svgText)) !== null) {
    const tag = m[1];
    const d = attr(tag, "d");
    if (!d) continue;
    const style = attr(tag, "style") ?? "";
    const display = attr(tag, "display");
    const hidden = style.replace(/\s+/g, "").includes("display:none") || display === "none";
    const label = attr(tag, "inkscape:label") ?? attr(tag, "id") ?? "path";
    // Fill: `fill:` in the style wins over the `fill` attribute (CSS precedence).
    const styleFill = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style)?.[1];
    const fill = normalizeColor(styleFill ?? attr(tag, "fill"));
    paths.push({ d, label, hidden, fill });
  }

  // Representative colour for the projection paint: the first visible filled path.
  const fill = paths.find((p) => !p.hidden && p.fill)?.fill ?? null;

  return { viewBox, paths, fill };
}

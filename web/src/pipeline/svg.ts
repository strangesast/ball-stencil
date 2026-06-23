/**
 * Minimal, DOM-free SVG document parsing.
 *
 * Extracts the viewBox (falling back to width/height with unit suffixes
 * stripped) and every <path> element's geometry/label/visibility — exactly the
 * inputs svgio.load_artwork needs. Kept dependency-free and environment-neutral
 * so the same code runs in the Web Worker and in Node tests.
 */

import { normalizeColor } from "../color";

/** 2-D affine transform [a, b, c, d, e, f] mapping (x,y) ->
 *  (a*x + c*y + e, b*x + d*y + f), matching the SVG matrix(...) convention. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose A∘B: the result applies B then A (A * B as SVG matrices). */
export function matmul(A: Matrix, B: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Apply a matrix to a point. */
export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** True for a transform that is not (numerically) the identity. */
export function isIdentity(m: Matrix): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
  );
}

const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const FUNC_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
const DEG = Math.PI / 180;

/** Parse an SVG `transform` attribute (a sequence of functions) into a single
 *  composed matrix. Unknown/malformed functions are skipped. */
export function parseTransform(value: string | null | undefined): Matrix {
  if (!value) return IDENTITY;
  let m: Matrix = IDENTITY;
  let fn: RegExpExecArray | null;
  FUNC_RE.lastIndex = 0;
  while ((fn = FUNC_RE.exec(value)) !== null) {
    const name = fn[1];
    const args = (fn[2].match(NUM_RE) ?? []).map(parseFloat);
    let t: Matrix | null = null;
    switch (name) {
      case "matrix":
        if (args.length >= 6) t = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case "translate":
        if (args.length >= 1) t = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case "scale":
        if (args.length >= 1) t = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case "rotate": {
        if (args.length >= 1) {
          const ang = args[0] * DEG;
          const cos = Math.cos(ang);
          const sin = Math.sin(ang);
          const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
          if (args.length >= 3) {
            const [, , cx, cy] = args;
            t = matmul(matmul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
          } else {
            t = rot;
          }
        }
        break;
      }
      case "skewX":
        if (args.length >= 1) t = [1, 0, Math.tan(args[0] * DEG), 1, 0, 0];
        break;
      case "skewY":
        if (args.length >= 1) t = [1, Math.tan(args[0] * DEG), 0, 1, 0, 0];
        break;
    }
    if (t) m = matmul(m, t);
  }
  return m;
}

export interface SvgPath {
  d: string;
  label: string; // inkscape:label -> id -> "path"
  hidden: boolean; // display:none via style or attribute
  fill: string | null; // normalized #rrggbb fill, or null (none/unspecified)
  /** Cumulative transform mapping the path's `d` coordinates to viewBox space
   *  (composed from ancestor <g transform> and the path's own transform). */
  transform: Matrix;
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

/** display:none via style or attribute. */
function tagHidden(style: string, display: string | undefined): boolean {
  return style.replace(/\s+/g, "").includes("display:none") || display === "none";
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

  // Walk container/path tags in document order so we can carry an accumulated
  // transform (CTM) down through nested <g transform=...> groups onto every
  // <path>. Inkscape and other editors routinely wrap geometry in a translated
  // or matrixed group; without applying it the artwork lands off-centre and the
  // viewBox-derived design centre no longer matches the geometry.
  const paths: SvgPath[] = [];
  // Stack of [CTM at group open, whether the group was hidden].
  const stack: { ctm: Matrix; hidden: boolean }[] = [{ ctm: IDENTITY, hidden: false }];
  const tagRe = /<(\/?)(g|path|svg)\b([^>]*?)(\/?)>/gis;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svgText)) !== null) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const tag = m[3];
    const selfClosing = m[4] === "/";
    const top = stack[stack.length - 1];

    if (name === "svg") continue; // viewBox already handled; never a geometry parent

    if (name === "g") {
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const groupHidden =
        top.hidden || tagHidden(attr(tag, "style") ?? "", attr(tag, "display"));
      const ctm = matmul(top.ctm, parseTransform(attr(tag, "transform")));
      if (!selfClosing) stack.push({ ctm, hidden: groupHidden });
      continue;
    }

    // name === "path"
    const d = attr(tag, "d");
    if (!d) continue;
    const style = attr(tag, "style") ?? "";
    const hidden = top.hidden || tagHidden(style, attr(tag, "display"));
    const label = attr(tag, "inkscape:label") ?? attr(tag, "id") ?? "path";
    // Fill: `fill:` in the style wins over the `fill` attribute (CSS precedence).
    const styleFill = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style)?.[1];
    const fill = normalizeColor(styleFill ?? attr(tag, "fill"));
    const transform = matmul(top.ctm, parseTransform(attr(tag, "transform")));
    paths.push({ d, label, hidden, fill, transform });
  }

  // Representative colour for the projection paint: the first visible filled path.
  const fill = paths.find((p) => !p.hidden && p.fill)?.fill ?? null;

  return { viewBox, paths, fill };
}

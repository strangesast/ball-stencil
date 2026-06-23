/**
 * Raster (ImageData) → filled-silhouette SVG. Pure, DOM-free core; mirrors
 * ball_stencil/raster.py (same function shape, option names, and defaults). Runs
 * inside trace.worker.ts (and Node tests); never touches the main thread.
 *
 * Input adapter only — it produces a `<svg viewBox><path d/></svg>` string that
 * flows through the existing pipeline (parseSvg → loadArtwork) exactly like an
 * uploaded SVG or a generated glyph. It is NOT a colour converter: both backends
 * emit a monochrome silhouette and a single sampled `fill` that feeds the
 * projection paint, copying glyph.ts's discipline (no `<g>`, no transforms, just
 * absolute-coordinate filled `<path>`s under the even-odd rule).
 *
 * The even-odd fold runs across EVERY path in the document, so we must emit a
 * SINGLE foreground silhouette (the §2.2 "silhouette, not illustration" rule).
 * Both tracers happily emit a separate background layer (potrace's white `<g>`,
 * ImageTracer's frame path); including it would XOR-cancel the silhouette into a
 * confusing half-empty stencil. We therefore feed each backend a pre-binarized
 * black-on-white mask and keep only the non-white (foreground) paths.
 *
 * Backends (parity with the Python port — same literal strings, same defaults):
 *   "potrace" (default): esm-potrace-wasm. Its wasm is embedded inside the ESM
 *     chunk (no separate .wasm asset in v0.4.4 — confirmed from the package), so
 *     `init()` takes no arguments and offline works via the precached JS chunk.
 *     Its SVG wraps paths in a `<g transform="translate(0,H) scale(0.1,-0.1)">`
 *     (10× + Y-flip); we bake that affine into absolute pixel coordinates because
 *     parseSvg ignores `<g>`/transforms.
 *   "color": ImageTracer.js — tolerant of photos; pixel-space output, no transform.
 *
 * `detail` despeckles (potrace turdsize / imagetracer pathomit); higher drops more
 * tiny islands so the constrained mesher isn't choked by trace noise. The final
 * cut-edge fidelity is still governed downstream by boundary_smoothness_mm /
 * chord_error_mm — a too-fine trace only wastes triangles.
 */
import { DEFAULT_PAINT_HEX } from "../color";

/** ImageData as seen by the pure core: the browser's ImageData satisfies this,
 *  and Node tests pass a plain object with the same fields. */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type TraceBackend = "potrace" | "color";

export interface TraceOptions {
  backend?: TraceBackend; // default "potrace"
  threshold?: number; // 0–255 bilevel cutoff / luminance split (default 128)
  invert?: boolean; // trace light-on-dark instead of dark-on-light (default false)
  detail?: number; // despeckle: potrace turdsize / imagetracer pathomit (default 2)
  fill?: string | null; // force fill #rrggbb; null → sample dominant fg colour
}

const DEFAULTS: Required<Omit<TraceOptions, "fill">> & { fill: string | null } = {
  backend: "potrace",
  threshold: 128,
  invert: false,
  detail: 2,
  fill: null,
};

/** Trace `imageData` to a canonical silhouette SVG. NB: binarizes `imageData.data`
 *  in place (the worker hands us a throwaway buffer per trace). */
export async function traceImageToSvg(
  imageData: ImageDataLike,
  opts: TraceOptions = {},
): Promise<{ svgText: string }> {
  const o = { ...DEFAULTS, ...opts };
  const { width: w, height: h } = imageData;

  const mask = foregroundMask(imageData, o.threshold, o.invert); // true == ink
  if (!mask.some((v) => v)) {
    throw new Error(
      "No foreground found at this threshold — adjust the threshold or invert for light-on-dark artwork.",
    );
  }
  const fill = o.fill ?? dominantFill(imageData, mask); // sample BEFORE binarizing
  binarizeInPlace(imageData, mask); // ink → black, field → white (feeds the backend)

  const subpaths =
    o.backend === "color"
      ? await traceColor(imageData, o.detail)
      : await tracePotrace(imageData, o.detail);
  if (subpaths.length === 0) throw new Error("Tracer produced no filled paths.");

  // One flat <path> with every subpath (outer rings + holes), like glyph.ts: the
  // even-odd fold across subpaths carves counters/holes out for free.
  const d = subpaths.join(" ");
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">` +
    `<path d="${d}" fill="${fill}"/></svg>`;
  return { svgText };
}

// -- mask + colour (mirror raster.py _foreground_mask / _dominant_fill) -------

function foregroundMask(img: ImageDataLike, threshold: number, invert: boolean): Uint8Array {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    // Rec. 601 luma, matching the Python core.
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const fg = invert ? luma >= threshold : luma < threshold;
    mask[p] = fg && data[i + 3] >= 128 ? 1 : 0; // transparent pixels are background
  }
  return mask;
}

function dominantFill(img: ImageDataLike, mask: Uint8Array): string {
  const { data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (mask[p]) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  }
  if (n === 0) return DEFAULT_PAINT_HEX;
  const hx = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

function binarizeInPlace(img: ImageDataLike, mask: Uint8Array): void {
  const { data } = img;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 0 : 255; // ink black on white field
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
}

// -- backends (lazy-imported; init/wasm cached per module load) ---------------

let potraceReady: Promise<typeof import("esm-potrace-wasm")> | null = null;
function loadPotrace() {
  // Cache the module + its one-time wasm init, like glyph.ts's fontCache.
  if (!potraceReady) {
    potraceReady = (async () => {
      const mod = await import("esm-potrace-wasm");
      await mod.init(); // no args: the wasm is embedded in the ESM chunk (v0.4.4)
      return mod;
    })();
  }
  return potraceReady;
}

async function tracePotrace(img: ImageDataLike, detail: number): Promise<string[]> {
  const { potrace } = await loadPotrace();
  // extractcolors:false → a single foreground <g fill="#000000"> for a bilevel
  // image; we still defensively drop any white layer below.
  const svg = await potrace(img as unknown as ImageData, {
    turdsize: Math.max(0, Math.round(detail)),
    turnpolicy: 4,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
    pathonly: false,
    extractcolors: false,
  });
  return extractForegroundSubpaths(svg);
}

let imagetracerReady: Promise<typeof import("imagetracerjs")> | null = null;
async function traceColor(img: ImageDataLike, detail: number): Promise<string[]> {
  if (!imagetracerReady) imagetracerReady = import("imagetracerjs");
  const ImageTracer = (await imagetracerReady).default;
  // 2 colours → a foreground + a background frame path; pixel-space, no transform.
  const svg = ImageTracer.imagedataToSVG(img as unknown as ImageData, {
    numberofcolors: 2,
    pathomit: Math.max(0, Math.round(detail)),
    ltres: 1,
    qtres: 1,
    colorsampling: 0,
  });
  return extractForegroundSubpaths(svg);
}

// -- SVG extraction + transform baking ----------------------------------------

/** Pull foreground `<path d>`s out of a tracer's SVG, dropping any white/
 *  background layer, and bake each path's group transform into absolute coords
 *  so the result honours the §0 contract (flat absolute `<path>`, no transforms). */
function extractForegroundSubpaths(svg: string): string[] {
  const out: string[] = [];
  // Walk <g ...>…</g> groups (potrace), falling back to bare <path> (imagetracer).
  const groupRe = /<g\b([^>]*)>([\s\S]*?)<\/g>/gi;
  let gm: RegExpExecArray | null;
  let sawGroup = false;
  while ((gm = groupRe.exec(svg)) !== null) {
    sawGroup = true;
    collectPaths(gm[1], gm[2], out);
  }
  if (!sawGroup) collectPaths("", svg, out);
  return out;
}

function collectPaths(containerAttrs: string, body: string, out: string[]): void {
  const xform = parseTransform(attrValue(containerAttrs, "transform"));
  const pathRe = /<path\b([^>]*?)\/?>/gis;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(body)) !== null) {
    const attrs = pm[1];
    const d = attrValue(attrs, "d");
    if (!d) continue;
    // Skip the background layer: its fill is (near-)white.
    if (isWhite(attrValue(attrs, "fill") ?? attrValue(containerAttrs, "fill"))) continue;
    out.push(xform ? transformPathData(d, xform) : d.trim());
  }
}

function attrValue(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : undefined;
}

function isWhite(fill: string | undefined): boolean {
  if (!fill) return false;
  const s = fill.trim().toLowerCase();
  return s === "#fff" || s === "#ffffff" || s === "white" || s === "rgb(255,255,255)" || s === "rgb(255, 255, 255)";
}

interface Affine { a: number; b: number; c: number; d: number; e: number; f: number; }

/** Parse the limited `translate(tx,ty) scale(sx,sy)` form the tracers emit. */
function parseTransform(t: string | undefined): Affine | null {
  if (!t) return null;
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  const tr = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/.exec(t);
  if (tr) { e = parseFloat(tr[1]); f = parseFloat(tr[2]); }
  const sc = /scale\(\s*([-\d.eE]+)(?:[ ,]+([-\d.eE]+))?\s*\)/.exec(t);
  if (sc) { a = parseFloat(sc[1]); d = sc[2] !== undefined ? parseFloat(sc[2]) : a; }
  // translate then scale: p' = (e + a*x, f + d*y)
  return { a, b, c, d, e, f };
}

const apply = (m: Affine, x: number, y: number): [number, number] => [
  m.a * x + m.c * y + m.e,
  m.b * x + m.d * y + m.f,
];

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const fmt = (n: number) => {
  const s = n.toFixed(3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/**
 * Re-emit `d` with `m` baked into every coordinate, as absolute commands.
 * Handles the command set the tracers produce (M L H V C S Q T Z, abs + rel);
 * throws on arcs (A), which neither potrace nor ImageTracer emit.
 */
function transformPathData(d: string, m: Affine): string {
  const tokens = tokenizeD(d);
  const parts: string[] = [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let prevCx = 0, prevCy = 0, prevQx = 0, prevQy = 0;
  let prevCmd = "";
  const out = (x: number, y: number) => { const [tx, ty] = apply(m, x, y); return `${fmt(tx)} ${fmt(ty)}`; };
  for (const t of tokens) {
    const rel = t.cmd === t.cmd.toLowerCase();
    const up = t.cmd.toUpperCase();
    const a = t.args;
    switch (up) {
      case "M": {
        const x = rel ? curX + a[0] : a[0], y = rel ? curY + a[1] : a[1];
        curX = x; curY = y; startX = x; startY = y;
        parts.push(`M${out(x, y)}`);
        // subsequent pairs are implicit L
        for (let i = 2; i + 1 < a.length; i += 2) {
          const lx = rel ? curX + a[i] : a[i], ly = rel ? curY + a[i + 1] : a[i + 1];
          curX = lx; curY = ly; parts.push(`L${out(lx, ly)}`);
        }
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < a.length; i += 2) {
          const x = rel ? curX + a[i] : a[i], y = rel ? curY + a[i + 1] : a[i + 1];
          curX = x; curY = y; parts.push(`L${out(x, y)}`);
        }
        break;
      }
      case "H": {
        for (const v of a) { const x = rel ? curX + v : v; curX = x; parts.push(`L${out(curX, curY)}`); }
        break;
      }
      case "V": {
        for (const v of a) { const y = rel ? curY + v : v; curY = y; parts.push(`L${out(curX, curY)}`); }
        break;
      }
      case "C": {
        for (let i = 0; i + 5 < a.length; i += 6) {
          const x1 = rel ? curX + a[i] : a[i], y1 = rel ? curY + a[i + 1] : a[i + 1];
          const x2 = rel ? curX + a[i + 2] : a[i + 2], y2 = rel ? curY + a[i + 3] : a[i + 3];
          const x = rel ? curX + a[i + 4] : a[i + 4], y = rel ? curY + a[i + 5] : a[i + 5];
          parts.push(`C${out(x1, y1)} ${out(x2, y2)} ${out(x, y)}`);
          prevCx = x2; prevCy = y2; curX = x; curY = y;
        }
        break;
      }
      case "S": {
        for (let i = 0; i + 3 < a.length; i += 4) {
          const x1 = prevCmd === "C" || prevCmd === "S" ? 2 * curX - prevCx : curX;
          const y1 = prevCmd === "C" || prevCmd === "S" ? 2 * curY - prevCy : curY;
          const x2 = rel ? curX + a[i] : a[i], y2 = rel ? curY + a[i + 1] : a[i + 1];
          const x = rel ? curX + a[i + 2] : a[i + 2], y = rel ? curY + a[i + 3] : a[i + 3];
          parts.push(`C${out(x1, y1)} ${out(x2, y2)} ${out(x, y)}`);
          prevCx = x2; prevCy = y2; curX = x; curY = y;
        }
        break;
      }
      case "Q": {
        for (let i = 0; i + 3 < a.length; i += 4) {
          const x1 = rel ? curX + a[i] : a[i], y1 = rel ? curY + a[i + 1] : a[i + 1];
          const x = rel ? curX + a[i + 2] : a[i + 2], y = rel ? curY + a[i + 3] : a[i + 3];
          parts.push(`Q${out(x1, y1)} ${out(x, y)}`);
          prevQx = x1; prevQy = y1; curX = x; curY = y;
        }
        break;
      }
      case "T": {
        for (let i = 0; i + 1 < a.length; i += 2) {
          const x1 = prevCmd === "Q" || prevCmd === "T" ? 2 * curX - prevQx : curX;
          const y1 = prevCmd === "Q" || prevCmd === "T" ? 2 * curY - prevQy : curY;
          const x = rel ? curX + a[i] : a[i], y = rel ? curY + a[i + 1] : a[i + 1];
          parts.push(`Q${out(x1, y1)} ${out(x, y)}`);
          prevQx = x1; prevQy = y1; curX = x; curY = y;
        }
        break;
      }
      case "Z": {
        parts.push("Z");
        curX = startX; curY = startY;
        break;
      }
      case "A":
        throw new Error("arc commands are not produced by the tracers");
    }
    prevCmd = up;
  }
  return parts.join(" ");
}

function tokenizeD(d: string): { cmd: string; args: number[] }[] {
  const toks: { cmd: string; args: number[] }[] = [];
  const re = /([MmLlHhVvCcSsQqTtZzAa])([^MmLlHhVvCcSsQqTtZzAa]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const args = (m[2].match(NUM) ?? []).map(Number);
    toks.push({ cmd: m[1], args });
  }
  return toks;
}

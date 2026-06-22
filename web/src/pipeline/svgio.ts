/**
 * SVG loading and filled-region extraction. Port of ball_stencil/svgio.py.
 *
 * Each <path> carries closed subpaths describing a filled silhouette under the
 * even-odd rule. We flatten every subpath and fold them with even-odd union
 * (== symmetric-difference of all ring interiors) to obtain the filled region,
 * which becomes the holes in the stencil shell.
 */

import type { Paths64 } from "clipper2-js";
import { Clip } from "./clip";
import { ParsedSvg } from "./svg";
import { parsePathSubpaths, flattenSubpath, dedupePolyline, Pt } from "./tessellate";

export interface Artwork {
  region: Paths64; // even-odd filled region, SVG units, snapped to grid
  viewbox: [number, number, number, number];
  center: [number, number];
  labels: string[];
}

function ringArea(pts: Pt[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2.0;
}

function subpathToRing(sub: ReturnType<typeof parsePathSubpaths>[number], tol: number): number[][] | null {
  let pts = dedupePolyline(flattenSubpath(sub, tol));
  if (pts.length < 3) return null;
  // close the ring
  if (Math.abs(pts[0][0] - pts[pts.length - 1][0]) > 1e-9 || Math.abs(pts[0][1] - pts[pts.length - 1][1]) > 1e-9) {
    pts = [...pts, pts[0]];
  }
  if (Math.abs(ringArea(pts)) <= 0) return null;
  return pts as number[][];
}

export function loadArtwork(
  parsed: ParsedSvg,
  chordTolSvg: number,
  clip: Clip,
  name = "input.svg",
): Artwork {
  const rings: number[][][] = [];
  const labels: string[] = [];
  for (const path of parsed.paths) {
    if (path.hidden) continue;
    labels.push(path.label);
    for (const sub of parsePathSubpaths(path.d)) {
      const ring = subpathToRing(sub, chordTolSvg);
      if (ring) rings.push(ring);
    }
  }
  if (rings.length === 0) {
    throw new Error(`No filled vector paths found in ${name}`);
  }
  // Even-odd fill == XOR of every ring interior, then grid-snapped + cleaned
  // (Shapely set_precision + make_valid). Snapping fixes R_ref to match the
  // reference, which measures the region's extent after set_precision.
  const region = clip.snapToGrid(clip.compact(clip.evenOddUnion(rings)));

  const [minx, miny, w, h] = parsed.viewBox;
  const center: [number, number] = [minx + w / 2.0, miny + h / 2.0];
  return { region, viewbox: parsed.viewBox, center, labels };
}

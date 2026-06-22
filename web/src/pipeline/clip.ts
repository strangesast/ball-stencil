/**
 * 2D geometry layer over Clipper2 (clipper2-js).
 *
 * This is the one substantial, justified dependency (robust polygon boolean ops
 * + offsetting). It replaces the Shapely usage in the Python reference:
 *   - even-odd fill            -> Union(rings, EvenOdd)        (== XOR fold)
 *   - difference (disc - cut)  -> Difference(.., NonZero)
 *   - buffer / offset          -> InflatePaths(Round, Polygon)
 *   - set_precision(grid)      -> all ops run at integer scale 1/grid, so every
 *                                 result is snapped to the grid (a superset of
 *                                 where Shapely snaps), guaranteeing clean topology
 *   - make_valid               -> Clipper re-polygonizes/normalizes on every op
 *   - get_parts / interiors    -> PolyTree hierarchy walk
 *
 * Everything here runs inside the worker (or Node tests); it is pure compute.
 */

import {
  Clipper,
  ClipperOffset,
  FillRule,
  JoinType,
  EndType,
  Path64,
  Paths64,
} from "clipper2-js";

export type Ring = number[]; // flat [x0,y0,x1,y1,...] in SVG (float) units
export interface Part {
  shell: number[][]; // ring as [[x,y],...]
  holes: number[][][];
}

export class Clip {
  readonly scale: number;
  readonly inv: number;

  /**
   * Clipper works on integers; we scale floats by `scale`. The precision is
   * kept FINE (≈1e-4 SVG units), independent of snap_grid, so boolean ops match
   * GEOS double precision and never manufacture thin snap-slivers at near-
   * tangent boundaries. Grid snapping (snap_grid) is applied later, only to the
   * sampled triangulation points (meshbuild.snapUnique) — exactly where the
   * reference relies on it for a clean weld/manifold.
   */
  readonly snapGrid: number;

  constructor(snapGrid: number, precision = 1e-4) {
    this.scale = 1.0 / precision;
    this.inv = precision;
    this.snapGrid = snapGrid;
  }

  /**
   * Snap every coordinate to the grid and re-clean (Shapely set_precision +
   * make_valid). Applied to the artwork region so R_ref — derived from the
   * region's max vertex radius — matches the reference, which snaps the region
   * to the grid before measuring. Heavy booleans still run at fine precision
   * (no snap-slivers); this only quantizes vertex positions.
   */
  snapToGrid(paths: Paths64): Paths64 {
    if (this.snapGrid <= 0) return paths;
    const g = this.snapGrid;
    const snapped: number[][][] = [];
    for (const ring of this.toRings(paths)) {
      const r: number[][] = [];
      for (const [x, y] of ring) r.push([Math.round(x / g) * g, Math.round(y / g) * g]);
      snapped.push(r);
    }
    // NonZero re-clean preserves hole orientation (outer +, hole -).
    return this.compact(this.clean(this.ringsToPaths(snapped)));
  }

  // -- conversions ---------------------------------------------------------
  private ringToPath(ring: number[][]): Path64 {
    const flat: number[] = [];
    for (const [x, y] of ring) {
      flat.push(Math.round(x * this.scale), Math.round(y * this.scale));
    }
    return Clipper.makePath(flat);
  }

  ringsToPaths(rings: number[][][]): Paths64 {
    const ps = new Paths64();
    for (const r of rings) ps.push(this.ringToPath(r));
    return ps;
  }

  private pathToRing(path: Path64): number[][] {
    const out: number[][] = [];
    for (const p of path) out.push([p.x * this.inv, p.y * this.inv]);
    return out;
  }

  toRings(paths: Paths64): number[][][] {
    return paths.map((p) => this.pathToRing(p));
  }

  // -- operations ----------------------------------------------------------

  /** Even-odd fill of a set of rings == XOR fold of their interiors. */
  evenOddUnion(rings: number[][][]): Paths64 {
    const subj = this.ringsToPaths(rings);
    return Clipper.Union(subj, undefined, FillRule.EvenOdd);
  }

  /** subject - clip, NonZero. */
  difference(subject: Paths64, clip: Paths64): Paths64 {
    return Clipper.Difference(subject, clip, FillRule.NonZero);
  }

  /** Normalize / make-valid via a NonZero self-union. */
  clean(paths: Paths64): Paths64 {
    return Clipper.Union(paths, undefined, FillRule.NonZero);
  }

  /**
   * Round-join polygon offset (Shapely buffer). deltaSvg in SVG units.
   * Uses an explicit arc tolerance (~12 segments/quadrant) — the static
   * InflatePaths default is near-zero, which at fine scale explodes every round
   * join into thousands of vertices and is catastrophically slow.
   */
  inflate(paths: Paths64, deltaSvg: number): Paths64 {
    if (paths.length === 0) return new Paths64();
    const delta = deltaSvg * this.scale;
    const arcTol = Math.max(1, Math.abs(delta) * 0.01);
    const co = new ClipperOffset(2.0, arcTol);
    co.addPaths(paths, JoinType.Round, EndType.Polygon);
    const sol = new Paths64();
    co.execute(delta, sol);
    return sol;
  }

  /** Inscribed regular polygon approximating a circle (Shapely point.buffer). */
  disc(cx: number, cy: number, r: number, steps = 2048): Paths64 {
    const ring: number[][] = [];
    for (let k = 0; k < steps; k++) {
      const a = (2 * Math.PI * k) / steps;
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return this.ringsToPaths([ring]);
  }

  /**
   * Drop degenerate / sub-grid contours (Shapely make_valid + set_precision
   * collapse these). A contour whose absolute area is below one grid cell is
   * boolean-engine noise, never real geometry.
   */
  compact(paths: Paths64): Paths64 {
    const areaEps = 1.0; // below one integer grid cell == sub-grid noise
    const out = new Paths64();
    for (const p of paths) {
      if (p.length < 3) continue;
      if (Math.abs(Clipper.area(p)) < areaEps) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * Reduce a polygon to grid resolution like Shapely set_precision: snap every
   * vertex to the grid, drop consecutive duplicates and collinear points. Done
   * per-contour (no global union) so it can't regenerate boundary slivers the
   * way a clipper2-js NonZero re-union does. This keeps the boundary vertex
   * density (and therefore the triangulation point count) in line with the
   * reference, whose material is set_precision(snap_grid) before sampling.
   */
  snapContours(paths: Paths64): Paths64 {
    if (this.snapGrid <= 0) return paths;
    const gi = this.snapGrid * this.scale; // grid in integer units
    const out = new Paths64();
    for (const ring of paths) {
      // snap to grid (integer multiples of gi), drop consecutive duplicates
      const snapped: { x: number; y: number }[] = [];
      for (const pt of ring) {
        const x = Math.round(pt.x / gi) * gi;
        const y = Math.round(pt.y / gi) * gi;
        const last = snapped[snapped.length - 1];
        if (!last || last.x !== x || last.y !== y) snapped.push({ x, y });
      }
      while (snapped.length > 1) {
        const a = snapped[0], b = snapped[snapped.length - 1];
        if (a.x === b.x && a.y === b.y) snapped.pop();
        else break;
      }
      // drop collinear vertices (exact, on grid)
      const n0 = snapped.length;
      if (n0 < 3) continue;
      const keep: { x: number; y: number }[] = [];
      for (let i = 0; i < n0; i++) {
        const a = snapped[(i - 1 + n0) % n0];
        const b = snapped[i];
        const c = snapped[(i + 1) % n0];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cross !== 0) keep.push(b);
      }
      if (keep.length < 3) continue;
      const p = new Path64();
      for (const q of keep) p.push(q);
      if (Math.abs(Clipper.area(p)) < 1.0) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * Douglas-Peucker simplify at the grid tolerance. set_precision(grid) not
   * only snaps but also drops vertices that stay within the grid of the edge;
   * exact-collinear removal misses near-collinear points on flattened curves,
   * leaving ~2x the boundary vertices. This brings the material vertex density
   * (and therefore the triangulation point count) in line with the reference.
   */
  simplify(paths: Paths64): Paths64 {
    if (this.snapGrid <= 0) return paths;
    const eps = this.snapGrid * this.scale;
    return Clipper.simplifyPaths(paths, eps, true);
  }

  isEmpty(paths: Paths64): boolean {
    if (paths.length === 0) return true;
    const areaEps = 1.0; // one integer grid cell
    for (const p of paths) if (p.length >= 3 && Math.abs(Clipper.area(p)) >= areaEps) return false;
    return true;
  }

  bounds(paths: Paths64): [number, number, number, number] {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of paths)
      for (const pt of p) {
        const x = pt.x * this.inv, y = pt.y * this.inv;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    return [minx, miny, maxx, maxy];
  }

  /** Max distance of any vertex from (cx,cy). */
  maxRadius(paths: Paths64, cx: number, cy: number): number {
    let m = 0;
    let any = false;
    for (const p of paths)
      for (const pt of p) {
        any = true;
        const d = Math.hypot(pt.x * this.inv - cx, pt.y * this.inv - cy);
        if (d > m) m = d;
      }
    return any ? m : 1.0;
  }

  /** Densify every contour so no segment exceeds `spacing`; return all coords. */
  segmentizeCoords(paths: Paths64, spacing: number): number[][] {
    const out: number[][] = [];
    for (const p of paths) {
      const n = p.length;
      if (n === 0) continue;
      for (let i = 0; i < n; i++) {
        const a = p[i];
        const b = p[(i + 1) % n];
        const ax = a.x * this.inv, ay = a.y * this.inv;
        const bx = b.x * this.inv, by = b.y * this.inv;
        out.push([ax, ay]);
        const len = Math.hypot(bx - ax, by - ay);
        if (len > spacing) {
          const segs = Math.ceil(len / spacing);
          for (let s = 1; s < segs; s++) {
            const t = s / segs;
            out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
          }
        }
      }
    }
    return out;
  }

  // -- hierarchy (components, holes, per-part area/centroid) ---------------
  //
  // clipper2-js executePolyTree is unreliable in this build, but a NonZero
  // union returns flat contours where outers and holes are simply oriented
  // opposite ways and never intersect. We reconstruct the polygon-with-holes
  // hierarchy from containment depth: even depth == filled (a component/part),
  // odd depth == hole, and each contour's immediate parent is its deepest
  // container. This matches shapely.get_parts + Polygon.interiors.

  parts(paths: Paths64): Part[] {
    // No re-union here: a NonZero clean of a 51-hole frame can regenerate thin
    // boundary slivers. The input paths are already valid Clipper output.
    const rings = this.toRings(paths).filter((r) => r.length >= 3 && Math.abs(ringSignedArea(r)) > 1e-9);
    const n = rings.length;
    if (n === 0) return [];
    // a representative interior point per contour (first vertex works since
    // contours are disjoint)
    const rep = rings.map((r) => r[0]);
    // depth_i = number of OTHER contours containing rep_i
    const depth = new Array<number>(n).fill(0);
    const parent = new Array<number>(n).fill(-1);
    for (let i = 0; i < n; i++) {
      let bestParent = -1;
      let bestDepth = -1;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (containsXY([rings[j]], rep[i][0], rep[i][1])) {
          depth[i]++;
          // track immediate parent as the container with the largest own depth
          const dj = depthOf(j, rings, rep);
          if (dj > bestDepth) {
            bestDepth = dj;
            bestParent = j;
          }
        }
      }
      parent[i] = bestParent;
    }
    const parts: Part[] = [];
    const partOfFilled = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (depth[i] % 2 === 0) {
        partOfFilled.set(i, parts.length);
        parts.push({ shell: rings[i], holes: [] });
      }
    }
    for (let i = 0; i < n; i++) {
      if (depth[i] % 2 === 1) {
        const pi = partOfFilled.get(parent[i]);
        if (pi !== undefined) parts[pi].holes.push(rings[i]);
      }
    }
    return parts;
  }
}

/**
 * Slab-bucketed boundary-edge index for exact erosion: a point is "comfortably
 * interior" (inside material.buffer(-r)) iff it is inside the material AND no
 * boundary edge is within r. clipper2-js's negative polygon offset is
 * unreliable on holes, so we test distance-to-boundary directly.
 */
export class BoundaryDist {
  private ax: Float64Array; private ay: Float64Array;
  private bx: Float64Array; private by: Float64Array;
  private ne: number;
  private yMin: number; private slabH: number; private nSlabs: number;
  private slabs: Int32Array[];

  constructor(rings: number[][][]) {
    const ax: number[] = [], ay: number[] = [], bx: number[] = [], by: number[] = [];
    let yMin = Infinity, yMax = -Infinity;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        ax.push(ring[j][0]); ay.push(ring[j][1]);
        bx.push(ring[i][0]); by.push(ring[i][1]);
        yMin = Math.min(yMin, ring[i][1]); yMax = Math.max(yMax, ring[i][1]);
      }
    }
    this.ne = ax.length;
    this.ax = Float64Array.from(ax); this.ay = Float64Array.from(ay);
    this.bx = Float64Array.from(bx); this.by = Float64Array.from(by);
    this.yMin = yMin;
    this.nSlabs = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(Math.max(1, this.ne))) * 4));
    const span = (yMax - yMin) || 1;
    this.slabH = span / this.nSlabs;
    const buckets: number[][] = Array.from({ length: this.nSlabs }, () => []);
    for (let e = 0; e < this.ne; e++) {
      const lo = Math.min(this.ay[e], this.by[e]);
      const hi = Math.max(this.ay[e], this.by[e]);
      let s0 = Math.floor((lo - yMin) / this.slabH);
      let s1 = Math.floor((hi - yMin) / this.slabH);
      if (s0 < 0) s0 = 0;
      if (s1 >= this.nSlabs) s1 = this.nSlabs - 1;
      for (let s = s0; s <= s1; s++) buckets[s].push(e);
    }
    this.slabs = buckets.map((b) => Int32Array.from(b));
  }

  /** True if the nearest boundary edge is at least r away (considering a y-band). */
  fartherThan(x: number, y: number, r: number): boolean {
    const r2 = r * r;
    let s0 = Math.floor((y - r - this.yMin) / this.slabH);
    let s1 = Math.floor((y + r - this.yMin) / this.slabH);
    if (s0 < 0) s0 = 0;
    if (s1 >= this.nSlabs) s1 = this.nSlabs - 1;
    const seen = new Set<number>();
    for (let s = s0; s <= s1; s++) {
      const bucket = this.slabs[s];
      for (let k = 0; k < bucket.length; k++) {
        const e = bucket[k];
        if (seen.has(e)) continue;
        seen.add(e);
        const vx = this.bx[e] - this.ax[e], vy = this.by[e] - this.ay[e];
        const wx = x - this.ax[e], wy = y - this.ay[e];
        const len2 = vx * vx + vy * vy;
        let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = wx - t * vx, dy = wy - t * vy;
        if (dx * dx + dy * dy < r2) return false;
      }
    }
    return true;
  }
}

/** Containment depth of contour j (number of contours that contain its rep). */
function depthOf(j: number, rings: number[][][], rep: number[][]): number {
  let d = 0;
  for (let k = 0; k < rings.length; k++) {
    if (k === j) continue;
    if (containsXY([rings[k]], rep[j][0], rep[j][1])) d++;
  }
  return d;
}

// -- ring / part geometry (float) ------------------------------------------

function ringSignedArea(ring: number[][]): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2.0;
}

/** Signed-area moments of a ring: returns [Araw, Mx, My]. */
function ringMoments(ring: number[][]): [number, number, number] {
  let a = 0, mx = 0, my = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    mx += (x0 + x1) * cross;
    my += (y0 + y1) * cross;
  }
  return [a / 2.0, mx / 6.0, my / 6.0];
}

export function partArea(part: Part): number {
  let A = 0;
  for (const r of [part.shell, ...part.holes]) A += ringMoments(r)[0];
  return Math.abs(A);
}

export function partCentroid(part: Part): [number, number] {
  let A = 0, Mx = 0, My = 0;
  for (const r of [part.shell, ...part.holes]) {
    const [a, mx, my] = ringMoments(r);
    A += a;
    Mx += mx;
    My += my;
  }
  if (Math.abs(A) < 1e-18) {
    // fall back to vertex average of the shell
    let sx = 0, sy = 0;
    for (const p of part.shell) {
      sx += p[0];
      sy += p[1];
    }
    const n = Math.max(1, part.shell.length);
    return [sx / n, sy / n];
  }
  return [Mx / A, My / A];
}

/** Even-odd point-in-region test over a flat list of rings (one-shot). */
export function containsXY(rings: number[][][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      const xi = ring[i][0], xj = ring[j][0];
      const intersect =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * Slab-bucketed even-odd point-in-polygon index. Built once over the material
 * rings, then queried for every lattice/triangle point — turns the per-query
 * cost from O(all edges) into O(edges in one horizontal slab). This is the
 * single hottest operation in the build.
 */
export class PipIndex {
  private x0: Float64Array;
  private y0: Float64Array;
  private x1: Float64Array;
  private y1: Float64Array;
  private ne: number;
  private yMin: number;
  private slabH: number;
  private nSlabs: number;
  private slabs: Int32Array[]; // edge indices per slab

  constructor(rings: number[][][]) {
    const ex0: number[] = [], ey0: number[] = [], ex1: number[] = [], ey1: number[] = [];
    let yMin = Infinity, yMax = -Infinity;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if (ring[i][1] === ring[j][1]) continue; // skip horizontal edges
        ex0.push(ring[j][0]); ey0.push(ring[j][1]);
        ex1.push(ring[i][0]); ey1.push(ring[i][1]);
        yMin = Math.min(yMin, ring[i][1], ring[j][1]);
        yMax = Math.max(yMax, ring[i][1], ring[j][1]);
      }
    }
    this.ne = ex0.length;
    this.x0 = Float64Array.from(ex0);
    this.y0 = Float64Array.from(ey0);
    this.x1 = Float64Array.from(ex1);
    this.y1 = Float64Array.from(ey1);
    this.yMin = yMin;
    this.nSlabs = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(this.ne)) * 4));
    const span = yMax - yMin || 1;
    this.slabH = span / this.nSlabs;
    const buckets: number[][] = Array.from({ length: this.nSlabs }, () => []);
    for (let e = 0; e < this.ne; e++) {
      const lo = Math.min(this.y0[e], this.y1[e]);
      const hi = Math.max(this.y0[e], this.y1[e]);
      let s0 = Math.floor((lo - yMin) / this.slabH);
      let s1 = Math.floor((hi - yMin) / this.slabH);
      if (s0 < 0) s0 = 0;
      if (s1 >= this.nSlabs) s1 = this.nSlabs - 1;
      for (let s = s0; s <= s1; s++) buckets[s].push(e);
    }
    this.slabs = buckets.map((b) => Int32Array.from(b));
  }

  contains(x: number, y: number): boolean {
    let s = Math.floor((y - this.yMin) / this.slabH);
    if (s < 0 || s >= this.nSlabs) return false;
    const bucket = this.slabs[s];
    let inside = false;
    for (let k = 0; k < bucket.length; k++) {
      const e = bucket[k];
      const yi = this.y1[e], yj = this.y0[e];
      if (yi > y !== yj > y) {
        const xi = this.x1[e], xj = this.x0[e];
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
}

/**
 * Build the watertight stencil shell mesh from the 2D material region.
 * Port of ball_stencil/meshbuild.py.
 *
 *   1. material region = disc(R_ref) - filled splashes      (Clipper, SVG units)
 *   2. sample boundary (densified) + interior (hex lattice) points
 *   3. Delaunay triangulate, keep triangles whose centroid lies in the material
 *   4. map every planar vertex to the inner and outer sphere radii
 *   5. stitch top + bottom + side walls (rim and every hole) -> closed manifold
 */

import Delaunator from "delaunator";
import { SweepContext } from "poly2tri";
import type { Paths64 } from "clipper2-js";
import { Clip, Part, partArea, partCentroid, PipIndex, BoundaryDist } from "./clip";
import { Mapper } from "./mapping";
import { Params, capAngleRad, innerRadius, outerRadius } from "./config";

export interface Mesh {
  vertices: Float64Array; // (V*3)
  faces: Int32Array; // (F*3)
  nPlanar: number; // outer verts [0:n], inner verts [n:2n]
}

export interface BuildResult {
  mesh: Mesh;
  material: Paths64;
  materialRings: number[][][];
  mapper: Mapper;
  rRef: number;
  center: [number, number];
  spacingSvg: number;
  islands: number[]; // on-sphere area (mm^2) per component, descending
  nCutRegions: number;
}

// -- helpers ----------------------------------------------------------------

function sphereArea(part: Part, mapper: Mapper, outerR: number): number {
  const [cx, cy] = partCentroid(part);
  const rho = Math.hypot(cx - mapper.cx, cy - mapper.cy);
  return partArea(part) * mapper.arealScale(rho, outerR);
}

function dropTiny(
  material: Paths64,
  p: Params,
  center: [number, number],
  rRef: number,
  clip: Clip,
): Paths64 {
  if (p.min_island_area_mm2 <= 0) return material;
  const parts = clip.parts(material);
  const mapper = new Mapper(center, rRef, capAngleRad(p), p.flip_v);
  const outerR = outerRadius(p);
  const keep = parts.filter((pt) => sphereArea(pt, mapper, outerR) >= p.min_island_area_mm2);
  if (keep.length === 0) {
    throw new Error(
      `every material component is below min_island_area_mm2 ` +
        `(${p.min_island_area_mm2} mm^2); nothing left to build -- lower ` +
        `--min-island or check the artwork scale`,
    );
  }
  if (keep.length === parts.length) return material;
  // Survivors are disjoint components; concatenate their (already correctly
  // oriented) rings directly. A re-union would regenerate boundary slivers.
  const rings: number[][][] = [];
  for (const pt of keep) {
    rings.push(pt.shell);
    for (const h of pt.holes) rings.push(h);
  }
  return clip.ringsToPaths(rings);
}

function componentAreas(material: Paths64, mapper: Mapper, outerR: number, clip: Clip): number[] {
  return clip
    .parts(material)
    .map((pt) => sphereArea(pt, mapper, outerR))
    .sort((a, b) => b - a);
}

function countHoles(material: Paths64, clip: Clip): number {
  let n = 0;
  for (const pt of clip.parts(material)) n += pt.holes.length;
  return n;
}

function interiorPoints(
  material: Paths64,
  materialRings: number[][][],
  matIndex: PipIndex,
  spacing: number,
  clip: Clip,
): number[][] {
  const [minx, miny, maxx, maxy] = clip.bounds(material);
  const dx = spacing;
  const dy = (spacing * Math.sqrt(3.0)) / 2.0;
  // Keep only points comfortably inside material.buffer(-0.5*spacing): inside
  // the material AND at least 0.5*spacing from every boundary edge. Computed
  // exactly via point-to-edge distance (clipper2-js negative offset is
  // unreliable on holes).
  const r = 0.5 * spacing;
  const dist = new BoundaryDist(materialRings);
  const pts: number[][] = [];
  let y = miny;
  let row = 0;
  while (y <= maxy + dy) {
    const offset = row % 2 ? dx / 2.0 : 0.0;
    for (let x = minx + offset; x < maxx + dx; x += dx) {
      if (matIndex.contains(x, y) && dist.fartherThan(x, y, r)) pts.push([x, y]);
    }
    y += dy;
    row += 1;
  }
  return pts;
}

function snapUnique(points: number[][], grid: number): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const [x, y] of points) {
    const gx = Math.round(x / grid);
    const gy = Math.round(y / grid);
    const key = gx + "," + gy;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([gx * grid, gy * grid]);
  }
  return out;
}

// -- triangulation strategies ----------------------------------------------

/** Legacy mesher: unconstrained Delaunay of sampled points, keep a triangle iff
 *  its centroid is inside the material. The cut edge is then a by-product of the
 *  centroid test and comes out faceted / sawtoothed. */
function triangulateCentroid(
  material: Paths64,
  materialRings: number[][][],
  p: Params,
  spacing: number,
  clip: Clip,
): { triIdx: number[][]; planar: number[][] } {
  const matIndex = new PipIndex(materialRings);
  const grid = p.snap_grid_svg > 0 ? p.snap_grid_svg : 1e-6;
  const bpts = clip.segmentizeCoords(material, spacing);
  const ipts = interiorPoints(material, materialRings, matIndex, spacing, clip);
  let pts = bpts.concat(ipts);
  pts = snapUnique(pts, grid);

  // Delaunay triangulate the point cloud.
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i][0];
    flat[i * 2 + 1] = pts[i][1];
  }
  const del = new Delaunator(flat);
  const tIdx = del.triangles;

  // weld planar vertices (keyed on the snap grid)
  const vmap = new Map<number, number>(); // pts-index -> planar-index
  const planar: number[][] = [];
  const vidx = (pi: number): number => {
    let i = vmap.get(pi);
    if (i === undefined) {
      i = planar.length;
      vmap.set(pi, i);
      planar.push(pts[pi]);
    }
    return i;
  };

  const triIdx: number[][] = [];
  for (let t = 0; t < tIdx.length; t += 3) {
    const i0 = tIdx[t], i1 = tIdx[t + 1], i2 = tIdx[t + 2];
    const ax = pts[i0][0], ay = pts[i0][1];
    const bx = pts[i1][0], by = pts[i1][1];
    const cx2 = pts[i2][0], cy2 = pts[i2][1];
    // keep iff centroid inside material
    const gx = (ax + bx + cx2) / 3.0;
    const gy = (ay + by + cy2) / 3.0;
    if (!matIndex.contains(gx, gy)) continue;
    const area2 = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
    let a = vidx(i0);
    let b = vidx(i1);
    let c = vidx(i2);
    if (area2 < 0.0) {
      const tmp = b;
      b = c;
      c = tmp;
    }
    triIdx.push([a, b, c]);
  }
  return { triIdx, planar };
}

/** Densify a closed ring so no edge exceeds `spacing` (keeps original vertices;
 *  port of shapely.segmentize used as the constrained boundary). */
function densifyRing(ring: number[][], spacing: number): number[][] {
  const out: number[][] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > spacing) {
      const segs = Math.ceil(len / spacing);
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return out;
}

/** Douglas-Peucker on the open chain `seq` (indices into `pts`); adds kept
 *  indices to `keep`. Iterative. Port of ball_stencil.meshbuild._rdp_open. */
function rdpOpen(pts: number[][], seq: number[], tol2: number, keep: Set<number>): void {
  const stack: [number, number][] = [[0, seq.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi <= lo + 1) continue;
    const [ax, ay] = pts[seq[lo]];
    const [bx, by] = pts[seq[hi]];
    const abx = bx - ax, aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    let dmax = -1.0;
    let idx = -1;
    for (let k = lo + 1; k < hi; k++) {
      const [px, py] = pts[seq[k]];
      let d2: number;
      if (ab2 > 1e-24) {
        const cross = (px - ax) * aby - (py - ay) * abx;
        d2 = (cross * cross) / ab2;
      } else {
        d2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      }
      if (d2 > dmax) {
        dmax = d2;
        idx = k;
      }
    }
    if (dmax > tol2) {
      keep.add(seq[idx]);
      stack.push([lo, idx]);
      stack.push([idx, hi]);
    }
  }
}

/** Douglas-Peucker simplify a *closed* ring (open coords, no repeated end),
 *  anchored at the lexicographically smallest vertex + the farthest from it so
 *  the result is invariant to where the engine started the ring. Port of
 *  ball_stencil.meshbuild._rdp_ring. */
function rdpRing(pts: number[][], tol: number): number[][] {
  const n = pts.length;
  if (n <= 4) return pts;
  let a0 = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i][0] < pts[a0][0] || (pts[i][0] === pts[a0][0] && pts[i][1] < pts[a0][1])) a0 = i;
  }
  let a1 = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - pts[a0][0];
    const dy = pts[i][1] - pts[a0][1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      a1 = i;
    }
  }
  if (a1 === a0) return pts;
  const keep = new Set<number>([a0, a1]);
  const arc = (lo: number, hi: number): number[] => {
    const seq: number[] = [];
    let i = lo;
    for (;;) {
      seq.push(i);
      if (i === hi) break;
      i = (i + 1) % n;
    }
    return seq;
  };
  const tol2 = tol * tol;
  rdpOpen(pts, arc(a0, a1), tol2, keep);
  rdpOpen(pts, arc(a1, a0), tol2, keep);
  return [...keep].sort((x, y) => x - y).map((i) => pts[i]);
}

/** Drop points closer than `minD` to their predecessor; poly2tri rejects
 *  coincident / sub-epsilon vertices. Returns null if fewer than 3 remain. */
function cleanRing(ring: number[][], minD: number): number[][] | null {
  if (ring.length < 3) return null;
  const out: number[][] = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i];
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > minD) out.push(p);
  }
  while (
    out.length > 3 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= minD
  ) {
    out.pop();
  }
  return out.length >= 3 ? out : null;
}

/** Interior hex-lattice Steiner points for one part (shell + holes), each held
 *  back `holdback*spacing` from every boundary so none lands on a constraint. */
function partSteiner(partRings: number[][][], spacing: number, holdback: number): number[][] {
  const matIndex = new PipIndex(partRings);
  const dist = new BoundaryDist(partRings);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const r of partRings)
    for (const [x, y] of r) {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  const dx = spacing;
  const dy = (spacing * Math.sqrt(3)) / 2;
  const rr = holdback * spacing;
  const pts: number[][] = [];
  let y = miny;
  let row = 0;
  while (y <= maxy + dy) {
    const off = row % 2 ? dx / 2 : 0;
    for (let x = minx + off; x < maxx + dx; x += dx) {
      if (matIndex.contains(x, y) && dist.fartherThan(x, y, rr)) pts.push([x, y]);
    }
    y += dy;
    row += 1;
  }
  return pts;
}

/** Conforming Delaunay (poly2tri): the material contour is a *constrained*
 *  boundary, so the cut edge IS the design curve (no centroid sawtooth / facet
 *  corner-cutting). Interior is filled with a TARGET_EDGE hex lattice as Steiner
 *  points. Mirrors ball_stencil.meshbuild._triangulate_constrained. */
function triangulateConstrained(
  material: Paths64,
  spacing: number,
  bndTol: number,
  clip: Clip,
): { triIdx: number[][]; planar: number[][] } {
  const minD = spacing * 0.02;
  const planar: number[][] = [];
  const vmap = new Map<string, number>();
  const vidx = (x: number, y: number): number => {
    const key = Math.round(x * 1e6) + "," + Math.round(y * 1e6);
    let i = vmap.get(key);
    if (i === undefined) {
      i = planar.length;
      vmap.set(key, i);
      planar.push([x, y]);
    }
    return i;
  };

  // Per ring: dedupe -> RDP simplify (canonical, lockstep) -> densify long edges.
  const prep = (ring: number[][]): number[][] | null => {
    const cleaned = cleanRing(ring, minD);
    if (!cleaned) return null;
    return densifyRing(rdpRing(cleaned, bndTol), spacing);
  };

  const triIdx: number[][] = [];
  for (const part of clip.parts(material)) {
    const shell = prep(part.shell);
    if (!shell) continue;
    const holes: number[][][] = [];
    const partRings: number[][][] = [shell];
    for (const h of part.holes) {
      const hr = prep(h);
      if (hr) {
        holes.push(hr);
        partRings.push(hr);
      }
    }
    const steiner = partSteiner(partRings, spacing, 0.6);

    const swctx = new SweepContext(shell.map(([x, y]) => ({ x, y })));
    for (const h of holes) swctx.addHole(h.map(([x, y]) => ({ x, y })));
    for (const [x, y] of steiner) swctx.addPoint({ x, y });
    swctx.triangulate();
    for (const tr of swctx.getTriangles()) {
      const p0 = tr.getPoint(0);
      const p1 = tr.getPoint(1);
      const p2 = tr.getPoint(2);
      const area2 = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
      let a = vidx(p0.x, p0.y);
      let b = vidx(p1.x, p1.y);
      let c = vidx(p2.x, p2.y);
      if (area2 < 0.0) {
        const tmp = b;
        b = c;
        c = tmp;
      }
      triIdx.push([a, b, c]);
    }
  }
  if (triIdx.length === 0) {
    throw new Error(
      "constrained triangulation produced no triangles (material may be " +
        "degenerate after cutting); check the SVG, design margin, or cut separation",
    );
  }
  return { triIdx, planar };
}

// -- pinch-vertex splitting (port of _split_pinch_vertices) -----------------

function splitPinchVertices(tris: number[][], planar: number[][]): [number[][], number[][]] {
  const edgeKey = (a: number, b: number) => a + "|" + b;
  const dirSet = new Set<string>();
  for (const [a, b, c] of tris) {
    dirSet.add(edgeKey(a, b));
    dirSet.add(edgeKey(b, c));
    dirSet.add(edgeKey(c, a));
  }
  const boundary: [number, number][] = [];
  for (const k of dirSet) {
    const [a, b] = k.split("|").map(Number);
    if (!dirSet.has(edgeKey(b, a))) boundary.push([a, b]);
  }
  const outDeg = new Map<number, number>();
  const inDeg = new Map<number, number>();
  for (const [a, b] of boundary) {
    outDeg.set(a, (outDeg.get(a) ?? 0) + 1);
    inDeg.set(b, (inDeg.get(b) ?? 0) + 1);
  }
  const pinch = new Set<number>();
  for (const [v, d] of outDeg) if (d > 1) pinch.add(v);
  for (const [v, d] of inDeg) if (d > 1) pinch.add(v);
  if (pinch.size === 0) return [tris, planar];

  const inc = new Map<number, number[]>();
  for (let ti = 0; ti < tris.length; ti++) {
    for (const v of tris[ti]) {
      if (pinch.has(v)) {
        const arr = inc.get(v);
        if (arr) arr.push(ti);
        else inc.set(v, [ti]);
      }
    }
  }
  // undirected edge -> incident triangle list
  const e2t = new Map<string, number[]>();
  const undKey = (x: number, y: number) => (x < y ? x + "_" + y : y + "_" + x);
  for (let ti = 0; ti < tris.length; ti++) {
    const [a, b, c] = tris[ti];
    for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = undKey(x, y);
      const arr = e2t.get(k);
      if (arr) arr.push(ti);
      else e2t.set(k, [ti]);
    }
  }
  const trisM = tris.map((t) => t.slice());
  const planarM = planar.slice();

  for (const v of pinch) {
    const T = inc.get(v)!;
    const tset = new Set(T);
    const parent = new Map<number, number>();
    for (const ti of T) parent.set(ti, ti);
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const nx = parent.get(x)!;
        parent.set(x, r);
        x = nx;
      }
      return r;
    };
    for (const ti of T) {
      for (const w of trisM[ti]) {
        if (w === v) continue;
        const arr = e2t.get(undKey(v, w)) ?? [];
        for (const tj of arr) {
          if (tset.has(tj) && tj !== ti) parent.set(find(ti), find(tj));
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (const ti of T) {
      const r = find(ti);
      const arr = groups.get(r);
      if (arr) arr.push(ti);
      else groups.set(r, [ti]);
    }
    if (groups.size <= 1) continue;
    const groupList = [...groups.values()];
    for (let g = 1; g < groupList.length; g++) {
      const nv = planarM.length;
      planarM.push([planarM[v][0], planarM[v][1]]);
      for (const ti of groupList[g]) {
        trisM[ti] = trisM[ti].map((x) => (x === v ? nv : x));
      }
    }
  }
  return [trisM, planarM];
}

// -- orientation + manifold assertion ---------------------------------------

function connectedComponents(faces: number[][], nVertices: number): Int32Array {
  const parent = new Int32Array(nVertices);
  for (let i = 0; i < nVertices; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const nx = parent[x];
      parent[x] = root;
      x = nx;
    }
    return root;
  };
  for (const tri of faces) {
    const r0 = find(tri[0]);
    for (let k = 1; k < 3; k++) {
      const rw = find(tri[k]);
      if (rw !== r0) parent[rw] = r0;
    }
  }
  const comp = new Int32Array(faces.length);
  for (let i = 0; i < faces.length; i++) comp[i] = find(faces[i][0]);
  return comp;
}

function orientOutward(vertices: Float64Array, faces: number[][]): void {
  if (faces.length === 0) return;
  const nV = vertices.length / 3;
  const triVol6 = new Float64Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    const [ia, ib, ic] = faces[i];
    const ax = vertices[ia * 3], ay = vertices[ia * 3 + 1], az = vertices[ia * 3 + 2];
    const bx = vertices[ib * 3], by = vertices[ib * 3 + 1], bz = vertices[ib * 3 + 2];
    const cx = vertices[ic * 3], cy = vertices[ic * 3 + 1], cz = vertices[ic * 3 + 2];
    // a . (b x c)
    const crx = by * cz - bz * cy;
    const cry = bz * cx - bx * cz;
    const crz = bx * cy - by * cx;
    triVol6[i] = ax * crx + ay * cry + az * crz;
  }
  const comp = connectedComponents(faces, nV);
  const volByComp = new Map<number, number>();
  for (let i = 0; i < faces.length; i++) {
    volByComp.set(comp[i], (volByComp.get(comp[i]) ?? 0) + triVol6[i]);
  }
  for (let i = 0; i < faces.length; i++) {
    if ((volByComp.get(comp[i]) ?? 0) < 0.0) {
      const f = faces[i];
      const t = f[1];
      f[1] = f[2];
      f[2] = t;
    }
  }
}

function assertManifold(faces: number[][]): void {
  if (faces.length === 0) return;
  const count = new Map<string, number>();
  const undKey = (x: number, y: number) => (x < y ? x + "_" + y : y + "_" + x);
  for (const [a, b, c] of faces) {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = undKey(x, y);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let nBad = 0;
  for (const v of count.values()) if (v > 2) nBad++;
  if (nBad) {
    throw new Error(
      `assembled shell has ${nBad} non-manifold edge(s); a cut hole ` +
        "likely touches the rim or another hole at a point. Increase " +
        "cut_separation_svg (--... wider separation) to pull them apart.",
    );
  }
}

// -- main entry -------------------------------------------------------------

export function buildShell(
  region: Paths64,
  center: [number, number],
  p: Params,
  clip: Clip,
): BuildResult {
  const [cx, cy] = center;
  const outerR = outerRadius(p);
  const innerR = innerRadius(p);

  const rRef =
    p.design_reference_radius !== null
      ? p.design_reference_radius
      : clip.maxRadius(region, cx, cy) * p.design_margin;

  // Dilate the cut holes (separates pinches, removes thin webbing).
  let cut = region;
  if (p.cut_separation_svg > 0) {
    cut = clip.clean(clip.inflate(region, p.cut_separation_svg));
  }

  const disc = clip.disc(cx, cy, rRef, 2048);
  // difference at fine precision (no snap-slivers). For the legacy "centroid"
  // mesher, reduce to grid resolution (Shapely set_precision): snap per-contour
  // + RDP-simplify at the grid tolerance. For "constrained" the clip carries no
  // snap grid, so these are no-ops and the contour stays at full precision.
  let material = clip.simplify(clip.snapContours(clip.compact(clip.difference(disc, cut))));
  if (clip.isEmpty(material)) {
    throw new Error(
      "material region is empty after cutting the artwork from the disc " +
        "(check the SVG, design margin, or cut separation); nothing to build",
    );
  }
  material = dropTiny(material, p, center, rRef, clip);

  const mapper = new Mapper(center, rRef, capAngleRad(p), p.flip_v);
  const scaleMid = mapper.scaleBounds(outerR)[1];
  const spacing = p.target_edge_mm / scaleMid;

  const materialRings = clip.toRings(material);

  // --- triangulate the 2D material region ---------------------------------
  // "constrained" reduces each contour to a canonical minimal vertex set
  // (Douglas-Peucker) well inside the smoothness budget -- a *shared* RDP
  // (identical in both ports) removes near-collinear flatten points whose
  // density differs between Clipper2 and GEOS, keeping the cut edge smooth AND
  // the two ports' vertex counts in lockstep.
  const bndTol = (0.5 * p.boundary_smoothness_mm) / scaleMid;
  const { triIdx, planar } =
    p.mesh_strategy === "constrained"
      ? triangulateConstrained(material, spacing, bndTol, clip)
      : triangulateCentroid(material, materialRings, p, spacing, clip);

  // resolve non-manifold pinch vertices
  const [tris, planar2] = splitPinchVertices(triIdx, planar);
  const n = planar2.length;

  // map to sphere: outer [0:n], inner [n:2n]
  const vertices = new Float64Array(2 * n * 3);
  for (let i = 0; i < n; i++) {
    const [px, py] = planar2[i];
    const [dx, dy, dz] = mapper.direction(px, py);
    vertices[i * 3] = dx * outerR;
    vertices[i * 3 + 1] = dy * outerR;
    vertices[i * 3 + 2] = dz * outerR;
    const j = (i + n) * 3;
    vertices[j] = dx * innerR;
    vertices[j + 1] = dy * innerR;
    vertices[j + 2] = dz * innerR;
  }

  const faces: number[][] = [];
  const dirSet = new Set<number>();
  const N = 2 * n; // edge-key base
  for (const [a, b, c] of tris) {
    faces.push([a, b, c]); // outer surface
    faces.push([a + n, c + n, b + n]); // inner surface (reversed)
    dirSet.add(a * N + b);
    dirSet.add(b * N + c);
    dirSet.add(c * N + a);
  }
  // boundary directed edges (no reverse partner) -> side walls
  for (const key of dirSet) {
    const a = Math.floor(key / N);
    const b = key % N;
    if (dirSet.has(b * N + a)) continue;
    faces.push([b, a, a + n]);
    faces.push([b, a + n, b + n]);
  }

  orientOutward(vertices, faces);
  assertManifold(faces);

  const facesArr = new Int32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    facesArr[i * 3] = faces[i][0];
    facesArr[i * 3 + 1] = faces[i][1];
    facesArr[i * 3 + 2] = faces[i][2];
  }

  const islands = componentAreas(material, mapper, outerR, clip);
  const nCut = countHoles(material, clip);

  return {
    mesh: { vertices, faces: facesArr, nPlanar: n },
    material,
    materialRings,
    mapper,
    rRef,
    center,
    spacingSvg: spacing,
    islands,
    nCutRegions: nCut,
  };
}

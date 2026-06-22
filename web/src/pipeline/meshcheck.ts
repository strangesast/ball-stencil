/**
 * Mesh validation: watertight manifold, winding, radius, triangle quality.
 * Port of ball_stencil/meshcheck.py.
 */

import { Mesh } from "./meshbuild";
import { Params, innerRadius, outerRadius } from "./config";

export interface MeshReport {
  nVertices: number;
  nFaces: number;
  isWatertight: boolean;
  isManifold: boolean;
  consistentWinding: boolean;
  nBoundaryEdges: number;
  nNonmanifoldEdges: number;
  maxRadiusErrorMm: number;
  edgeLenMin: number;
  edgeLenMax: number;
  edgeLenMean: number;
  maxAspectRatio: number;
  signedVolumeMm3: number;
  nDegenerate: number;
}

export function reportOk(r: MeshReport, p: Params): boolean {
  return (
    r.isWatertight &&
    r.isManifold &&
    r.consistentWinding &&
    r.maxRadiusErrorMm <= p.radius_tolerance_mm &&
    r.nDegenerate === 0
  );
}

export function checkMesh(mesh: Mesh, p: Params): MeshReport {
  const v = mesh.vertices;
  const f = mesh.faces;
  const n = mesh.nPlanar;
  const nFaces = f.length / 3;
  const nVertices = v.length / 3;
  const base = nVertices; // edge-key base

  // --- edges ---
  const undCount = new Map<number, number>();
  const dirSeen = new Set<number>();
  let dirDup = false;
  const addUnd = (a: number, b: number) => {
    const k = a < b ? a * base + b : b * base + a;
    undCount.set(k, (undCount.get(k) ?? 0) + 1);
  };
  const addDir = (a: number, b: number) => {
    const k = a * base + b;
    if (dirSeen.has(k)) dirDup = true;
    else dirSeen.add(k);
  };
  for (let i = 0; i < nFaces; i++) {
    const a = f[i * 3], b = f[i * 3 + 1], c = f[i * 3 + 2];
    addUnd(a, b); addUnd(b, c); addUnd(c, a);
    addDir(a, b); addDir(b, c); addDir(c, a);
  }
  let nBoundary = 0;
  let nNonmanifold = 0;
  let allDeg2 = true;
  for (const cnt of undCount.values()) {
    if (cnt === 1) nBoundary++;
    if (cnt > 2) nNonmanifold++;
    if (cnt !== 2) allDeg2 = false;
  }
  const hasFaces = nFaces > 0;
  const isWatertight = hasFaces && nBoundary === 0 && nNonmanifold === 0;
  const isManifold = hasFaces && allDeg2;
  const consistentWinding = hasFaces && !dirDup && isWatertight;

  // --- radius error ---
  let maxErr = 0;
  const outerR = outerRadius(p);
  const innerR = innerRadius(p);
  for (let i = 0; i < n; i++) {
    const norm = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    const e = Math.abs(norm - outerR);
    if (e > maxErr) maxErr = e;
  }
  for (let i = n; i < nVertices; i++) {
    const norm = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    const e = Math.abs(norm - innerR);
    if (e > maxErr) maxErr = e;
  }

  // --- triangle quality + volume ---
  let edgeMin = Infinity, edgeMax = 0, edgeSum = 0;
  let maxAspect = 0;
  let nDegenerate = 0;
  let vol6 = 0;
  for (let i = 0; i < nFaces; i++) {
    const ia = f[i * 3], ib = f[i * 3 + 1], ic = f[i * 3 + 2];
    const ax = v[ia * 3], ay = v[ia * 3 + 1], az = v[ia * 3 + 2];
    const bx = v[ib * 3], by = v[ib * 3 + 1], bz = v[ib * 3 + 2];
    const cx = v[ic * 3], cy = v[ic * 3 + 1], cz = v[ic * 3 + 2];
    const e0 = Math.hypot(bx - ax, by - ay, bz - az);
    const e1 = Math.hypot(cx - bx, cy - by, cz - bz);
    const e2 = Math.hypot(ax - cx, ay - cy, az - cz);
    edgeSum += e0 + e1 + e2;
    edgeMin = Math.min(edgeMin, e0, e1, e2);
    edgeMax = Math.max(edgeMax, e0, e1, e2);
    const longest = Math.max(e0, e1, e2);
    const shortest = Math.min(e0, e1, e2);
    if (shortest > 1e-12) {
      const asp = longest / shortest;
      if (asp > maxAspect) maxAspect = asp;
    }
    // area = 0.5 |(b-a) x (c-a)|
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    const crx = uy * wz - uz * wy;
    const cry = uz * wx - ux * wz;
    const crz = ux * wy - uy * wx;
    const area = 0.5 * Math.hypot(crx, cry, crz);
    if (area <= 1e-9 || shortest <= 1e-12) nDegenerate++;
    // a . (b x c)
    const bcx = by * cz - bz * cy;
    const bcy = bz * cx - bx * cz;
    const bcz = bx * cy - by * cx;
    vol6 += ax * bcx + ay * bcy + az * bcz;
  }
  const nEdges = nFaces * 3;

  return {
    nVertices,
    nFaces,
    isWatertight,
    isManifold,
    consistentWinding,
    nBoundaryEdges: nBoundary,
    nNonmanifoldEdges: nNonmanifold,
    maxRadiusErrorMm: maxErr,
    edgeLenMin: nEdges ? edgeMin : 0,
    edgeLenMax: nEdges ? edgeMax : 0,
    edgeLenMean: nEdges ? edgeSum / nEdges : 0,
    maxAspectRatio: maxAspect,
    signedVolumeMm3: vol6 / 6.0,
    nDegenerate,
  };
}

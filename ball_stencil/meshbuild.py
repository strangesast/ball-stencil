"""Build the watertight stencil shell mesh from the 2D material region.

Pipeline:
  1. material region = disc(R_ref) - filled splashes   (shapely, SVG units)
  2. sample boundary (densified) + interior (hex lattice) points
  3. Delaunay triangulate, keep triangles whose centroid lies in the material
  4. map every planar vertex to the inner and outer sphere radii
  5. stitch top + bottom + side walls (rim and every hole) -> closed manifold
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import sqrt

import numpy as np
import shapely
from shapely.geometry import MultiPoint, Point

from .mapping import Mapper, build_mapper


@dataclass
class Mesh:
    vertices: np.ndarray            # (V,3) float64
    faces: np.ndarray               # (F,3) int64
    n_planar: int                   # outer verts [0:n], inner verts [n:2n]


@dataclass
class BuildResult:
    mesh: Mesh
    material: shapely.Geometry
    mapper: Mapper
    r_ref: float
    center: np.ndarray
    spacing_svg: float
    islands: list[float]            # area (mm^2 on sphere approx via planar*scale^2) per component
    n_cut_regions: int


def _region_max_radius(region: shapely.Geometry, center: np.ndarray) -> float:
    xy = shapely.get_coordinates(region)
    if len(xy) == 0:
        return 1.0
    d = np.hypot(xy[:, 0] - center[0], xy[:, 1] - center[1])
    return float(d.max())


def _boundary_points(material: shapely.Geometry, spacing: float) -> np.ndarray:
    dense = shapely.segmentize(material, spacing)
    xy = shapely.get_coordinates(dense)
    return xy.astype(np.float64)


def _interior_points(material: shapely.Geometry, spacing: float) -> np.ndarray:
    minx, miny, maxx, maxy = material.bounds
    dx = spacing
    dy = spacing * sqrt(3.0) / 2.0
    rows = []
    y = miny
    row = 0
    while y <= maxy + dy:
        offset = (dx / 2.0) if (row % 2) else 0.0
        xs = np.arange(minx + offset, maxx + dx, dx)
        ys = np.full_like(xs, y)
        rows.append(np.column_stack([xs, ys]))
        y += dy
        row += 1
    if not rows:
        return np.zeros((0, 2), dtype=np.float64)
    pts = np.vstack(rows)
    # keep points comfortably inside the material so we don't make slivers
    inner = material.buffer(-0.5 * spacing)
    if inner.is_empty:
        return np.zeros((0, 2), dtype=np.float64)
    shapely.prepare(inner)
    mask = shapely.contains_xy(inner, pts[:, 0], pts[:, 1])
    return pts[mask]


def _snap_unique(points: np.ndarray, grid: float) -> np.ndarray:
    """Snap to ``grid`` and drop duplicates; guarantees a minimum point spacing."""
    snapped = np.round(points / grid) * grid
    _, idx = np.unique(snapped, axis=0, return_index=True)
    return snapped[np.sort(idx)]


def build_shell(
    region: shapely.Geometry,
    center,
    cfg,
) -> BuildResult:
    center = np.asarray(center, dtype=np.float64)

    # --- reference radius + material region ---------------------------------
    if cfg.design_reference_radius is not None:
        r_ref = float(cfg.design_reference_radius)
    else:
        r_ref = _region_max_radius(region, center) * cfg.design_margin

    # Dilate the cut holes so boundaries that meet at a single point merge or
    # separate cleanly (no pinch vertices -> manifold shell) and thin webbing
    # is removed.
    cut = region
    if cfg.cut_separation_svg > 0:
        cut = shapely.make_valid(region.buffer(cfg.cut_separation_svg, quad_segs=8))

    disc = Point(center[0], center[1]).buffer(r_ref, quad_segs=512)
    material = shapely.make_valid(disc.difference(cut))
    if cfg.snap_grid_svg > 0:
        material = shapely.make_valid(shapely.set_precision(material, cfg.snap_grid_svg))
    material = _drop_tiny(material, cfg, center, r_ref)

    mapper = build_mapper(center, r_ref, cfg.cap_angle_rad, cfg.flip_v)
    _, scale_mid, _ = mapper.scale_bounds(cfg.outer_radius_mm)
    spacing = cfg.target_edge_mm / scale_mid

    # --- sample + triangulate -----------------------------------------------
    grid = cfg.snap_grid_svg if cfg.snap_grid_svg > 0 else 10.0 ** -6
    bpts = _boundary_points(material, spacing)
    ipts = _interior_points(material, spacing)
    pts = np.vstack([bpts, ipts]) if len(ipts) else bpts
    pts = _snap_unique(pts, grid)

    mp = MultiPoint(pts)
    tris_geom = shapely.delaunay_triangles(mp)
    tri_polys = list(shapely.get_parts(tris_geom))

    shapely.prepare(material)
    cents = shapely.centroid(tri_polys)
    keep_mask = shapely.contains(material, cents)

    # planar vertex table (welded onto the snap grid)
    vmap: dict[tuple, int] = {}
    planar: list[tuple[float, float]] = []

    def vidx(x: float, y: float) -> int:
        key = (round(x / grid), round(y / grid))
        i = vmap.get(key)
        if i is None:
            i = len(planar)
            vmap[key] = i
            planar.append((x, y))
        return i

    tri_idx: list[tuple[int, int, int]] = []
    for poly, keep in zip(tri_polys, keep_mask):
        if not keep:
            continue
        coords = list(poly.exterior.coords)[:3]
        (ax, ay), (bx, by), (cx, cy) = coords
        # orient CCW (positive signed area)
        area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        a = vidx(ax, ay)
        b = vidx(bx, by)
        c = vidx(cx, cy)
        if area2 < 0.0:
            b, c = c, b
        tri_idx.append((a, b, c))

    # Resolve non-manifold (pinch) vertices: a boundary vertex whose incident
    # triangles form two separate fans is split so each fan gets its own copy.
    tri_idx, planar = _split_pinch_vertices(tri_idx, planar)

    planar_arr = np.asarray(planar, dtype=np.float64)
    n = len(planar_arr)

    # --- map to sphere: outer [0:n], inner [n:2n] ---------------------------
    dirs = mapper.directions(planar_arr)
    outer = dirs * cfg.outer_radius_mm
    inner = dirs * cfg.inner_radius_mm
    vertices = np.vstack([outer, inner]).astype(np.float64)

    faces: list[tuple[int, int, int]] = []
    edge_set = set()
    for (a, b, c) in tri_idx:
        faces.append((a, b, c))                 # outer surface
        faces.append((a + n, c + n, b + n))     # inner surface (reversed)
        edge_set.update([(a, b), (b, c), (c, a)])

    # boundary directed edges (no reverse partner) -> side walls
    for (a, b) in edge_set:
        if (b, a) in edge_set:
            continue
        # wall quad outer_a,outer_b,inner_b,inner_a
        faces.append((b, a, a + n))
        faces.append((b, a + n, b + n))

    faces_arr = np.asarray(faces, dtype=np.int64)
    mesh = Mesh(vertices=vertices, faces=faces_arr, n_planar=n)
    _orient_outward(mesh)

    islands = _component_areas(material, mapper, cfg)
    n_cut = _count_holes(material)
    return BuildResult(
        mesh=mesh, material=material, mapper=mapper, r_ref=r_ref, center=center,
        spacing_svg=spacing, islands=islands, n_cut_regions=n_cut,
    )


def _split_pinch_vertices(tris, planar):
    """Split non-manifold boundary vertices so every vertex link is one fan.

    A pinch vertex has >1 outgoing (or incoming) boundary edge: its incident
    triangles form multiple fans that touch only at the vertex.  We duplicate
    the vertex per fan so the resulting shell is a clean 2-manifold.
    """
    from collections import defaultdict

    edge_set = set()
    for (a, b, c) in tris:
        edge_set.update([(a, b), (b, c), (c, a)])
    boundary = [(a, b) for (a, b) in edge_set if (b, a) not in edge_set]

    out_deg, in_deg = defaultdict(int), defaultdict(int)
    for (a, b) in boundary:
        out_deg[a] += 1
        in_deg[b] += 1
    pinch = {v for v, d in out_deg.items() if d > 1}
    pinch |= {v for v, d in in_deg.items() if d > 1}
    if not pinch:
        return tris, planar

    inc = defaultdict(list)
    for ti, (a, b, c) in enumerate(tris):
        for v in (a, b, c):
            if v in pinch:
                inc[v].append(ti)

    e2t = defaultdict(list)
    for ti, (a, b, c) in enumerate(tris):
        for x, y in ((a, b), (b, c), (c, a)):
            e2t[frozenset((x, y))].append(ti)

    planar = list(planar)
    tris = [list(t) for t in tris]

    for v in pinch:
        T = inc[v]
        tset = set(T)
        parent = {ti: ti for ti in T}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for ti in T:
            for w in tris[ti]:
                if w == v:
                    continue
                for tj in e2t.get(frozenset((v, w)), ()):
                    if tj in tset and tj != ti:
                        parent[find(ti)] = find(tj)

        groups = defaultdict(list)
        for ti in T:
            groups[find(ti)].append(ti)
        if len(groups) <= 1:
            continue
        for grp in list(groups.values())[1:]:
            nv = len(planar)
            planar.append(planar[v])
            for ti in grp:
                tris[ti] = [nv if x == v else x for x in tris[ti]]

    return [tuple(t) for t in tris], planar


def _orient_outward(mesh: Mesh) -> None:
    """Flip all faces if the net signed volume is negative (normals inward)."""
    v = mesh.vertices
    f = mesh.faces
    a = v[f[:, 0]]
    b = v[f[:, 1]]
    c = v[f[:, 2]]
    vol = np.sum(a * np.cross(b, c)) / 6.0
    if vol < 0.0:
        mesh.faces = f[:, [0, 2, 1]].copy()


def _drop_tiny(material, cfg, center, r_ref):
    if cfg.min_island_area_mm2 <= 0:
        return material
    parts = list(shapely.get_parts(material))
    mapper = build_mapper(center, r_ref, cfg.cap_angle_rad, cfg.flip_v)
    _, scale_mid, _ = mapper.scale_bounds(cfg.outer_radius_mm)
    keep = [p for p in parts if p.area * scale_mid * scale_mid >= cfg.min_island_area_mm2]
    if len(keep) == len(parts):
        return material
    return shapely.union_all(keep)


def _component_areas(material, mapper, cfg) -> list[float]:
    _, scale_mid, _ = mapper.scale_bounds(cfg.outer_radius_mm)
    return sorted(
        (float(p.area * scale_mid * scale_mid) for p in shapely.get_parts(material)),
        reverse=True,
    )


def _count_holes(material) -> int:
    n = 0
    for p in shapely.get_parts(material):
        n += len(p.interiors)
    return n

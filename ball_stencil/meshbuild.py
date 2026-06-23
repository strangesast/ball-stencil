"""Build the watertight stencil shell mesh from the 2D material region.

Pipeline:
  1. material region = disc(R_ref) - filled splashes   (shapely, SVG units)
  2. triangulate it (``cfg.mesh_strategy``):
       - "constrained": conforming Delaunay (poly2tri) with the design contour as
         a *constrained* boundary, so the cut edge IS the artwork curve (smooth).
         The contour is flattened to ``BOUNDARY_SMOOTHNESS_MM`` and RDP-reduced;
         the interior is a TARGET_EDGE hex lattice of Steiner points.
       - "centroid" (legacy): sample boundary + interior, unconstrained Delaunay,
         keep triangles whose centroid lies in the material -> faceted cut edge.
  3. map every planar vertex to the inner and outer sphere radii
  4. stitch top + bottom + side walls (rim and every hole) -> closed manifold
"""

from __future__ import annotations

from dataclasses import dataclass
from math import sqrt, hypot

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


def _interior_points(material: shapely.Geometry, spacing: float, holdback: float = 0.5) -> np.ndarray:
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
    # keep points comfortably inside the material so we don't make slivers (and,
    # for the constrained mesher, so no Steiner point lands on a boundary edge)
    inner = material.buffer(-holdback * spacing)
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
    # is removed. The constrained mesher uses a rounder join (more segments) so
    # the dilated hole corners stay smooth where the artwork is convex.
    cut = region
    if cfg.cut_separation_svg > 0:
        quad_segs = 16 if cfg.mesh_strategy == "constrained" else 8
        cut = shapely.make_valid(region.buffer(cfg.cut_separation_svg, quad_segs=quad_segs))

    disc = Point(center[0], center[1]).buffer(r_ref, quad_segs=512)
    material = shapely.make_valid(disc.difference(cut))
    # The legacy centroid mesher snaps the material to the topology grid (clean
    # weld + sliver removal). The constrained mesher keeps the contour at full
    # precision -- grid-snapping it would re-introduce the stair-steps we are
    # trying to eliminate; cut_separation already guarantees a clean manifold.
    if cfg.mesh_strategy != "constrained" and cfg.snap_grid_svg > 0:
        material = shapely.make_valid(shapely.set_precision(material, cfg.snap_grid_svg))
    material = _drop_tiny(material, cfg, center, r_ref)
    if material.is_empty:
        raise ValueError(
            "material region is empty after cutting the artwork from the disc "
            "(check the SVG, design margin, or cut separation); nothing to build"
        )

    mapper = build_mapper(center, r_ref, cfg.cap_angle_rad, cfg.flip_v)
    _, scale_mid, _ = mapper.scale_bounds(cfg.outer_radius_mm)
    spacing = cfg.target_edge_mm / scale_mid

    # --- triangulate the 2D material region ---------------------------------
    if cfg.mesh_strategy == "constrained":
        # Reduce each contour to a canonical minimal vertex set (Douglas-Peucker)
        # well inside the smoothness budget. The raw flatten leaves many near-
        # collinear points whose density differs between GEOS and Clipper2; a
        # *shared* RDP (identical in both ports) keeps the cut edge smooth AND
        # the two ports' vertex counts in lockstep.
        bnd_tol = 0.5 * cfg.boundary_smoothness_mm / scale_mid
        tri_idx, planar = _triangulate_constrained(material, spacing, bnd_tol)
    else:
        tri_idx, planar = _triangulate_centroid(material, cfg, spacing)

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
    _assert_manifold(mesh.faces)

    islands = _component_areas(material, mapper, cfg)
    n_cut = _count_holes(material)
    return BuildResult(
        mesh=mesh, material=material, mapper=mapper, r_ref=r_ref, center=center,
        spacing_svg=spacing, islands=islands, n_cut_regions=n_cut,
    )


def _triangulate_centroid(material, cfg, spacing):
    """Legacy mesher: unconstrained Delaunay of sampled points, keep a triangle
    iff its centroid is inside the material. Returns (tri_idx, planar)."""
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
    return tri_idx, planar


def _clean_ring(ring, min_d: float):
    """Ring coords as an (N,2) array, closing duplicate dropped and points closer
    than ``min_d`` merged (poly2tri rejects coincident / sub-epsilon vertices)."""
    xy = np.asarray(ring.coords, dtype=np.float64)
    if len(xy) >= 2 and abs(xy[0, 0] - xy[-1, 0]) < 1e-12 and abs(xy[0, 1] - xy[-1, 1]) < 1e-12:
        xy = xy[:-1]
    if len(xy) < 3:
        return None
    out = [xy[0]]
    for p in xy[1:]:
        if hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > min_d:
            out.append(p)
    while len(out) > 3 and hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= min_d:
        out.pop()
    if len(out) < 3:
        return None
    return np.asarray(out, dtype=np.float64)


def _rdp_open(pts: np.ndarray, seq: list[int], tol: float, keep: set[int]) -> None:
    """Douglas-Peucker on the open chain ``seq`` (global indices into ``pts``);
    adds kept indices to ``keep``. Iterative to avoid Python recursion limits."""
    stack = [(0, len(seq) - 1)]
    tol2 = tol * tol
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = pts[seq[lo]]
        bx, by = pts[seq[hi]]
        abx, aby = bx - ax, by - ay
        ab2 = abx * abx + aby * aby
        dmax = -1.0
        idx = -1
        for k in range(lo + 1, hi):
            px, py = pts[seq[k]]
            if ab2 > 1e-24:
                cross = (px - ax) * aby - (py - ay) * abx
                d2 = cross * cross / ab2
            else:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            if d2 > dmax:
                dmax = d2
                idx = k
        if dmax > tol2:
            keep.add(seq[idx])
            stack.append((lo, idx))
            stack.append((idx, hi))


def _rdp_ring(pts: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker simplify a *closed* ring (open coords, no repeated end).

    Anchored at the lexicographically smallest vertex + the vertex farthest from
    it, so the result is invariant to where the boolean engine started the ring
    -- letting the two ports converge to the same minimal vertex set.
    """
    n = len(pts)
    if n <= 4:
        return pts
    a0 = int(np.lexsort((pts[:, 1], pts[:, 0]))[0])
    d = (pts[:, 0] - pts[a0, 0]) ** 2 + (pts[:, 1] - pts[a0, 1]) ** 2
    a1 = int(np.argmax(d))
    if a1 == a0:
        return pts
    keep: set[int] = {a0, a1}

    def arc(lo: int, hi: int) -> list[int]:
        seq = []
        i = lo
        while True:
            seq.append(i)
            if i == hi:
                break
            i = (i + 1) % n
        return seq

    _rdp_open(pts, arc(a0, a1), tol, keep)
    _rdp_open(pts, arc(a1, a0), tol, keep)
    return pts[sorted(keep)]


def _densify_ring(pts: np.ndarray, spacing: float) -> np.ndarray:
    """Subdivide any ring edge longer than ``spacing`` (keeps original vertices),
    so the constrained boundary tracks the sphere on long runs like the rim."""
    out: list = []
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        out.append((ax, ay))
        length = hypot(bx - ax, by - ay)
        if length > spacing:
            segs = int(np.ceil(length / spacing))
            for s in range(1, segs):
                t = s / segs
                out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    return np.asarray(out, dtype=np.float64)


def _triangulate_constrained(material, spacing, bnd_tol):
    """Conforming Delaunay (poly2tri): the material contour is a *constrained*
    boundary, so the cut edge IS the design curve (no centroid sawtooth / facet
    corner-cutting). Interior is filled with a TARGET_EDGE hex lattice as Steiner
    points. Returns (tri_idx, planar).

    poly2tri's pure-Python port legalises recursively; a dense splash overflows
    the default limit, so we triangulate inside a thread with a large stack.
    """
    # Per ring: dedupe -> RDP simplify (canonical, lockstep) -> densify long edges
    # (e.g. the disc rim) to ~spacing. The result is the constrained boundary.
    min_d = spacing * 0.02
    jobs = []

    def prep(ring):
        cleaned = _clean_ring(ring, min_d)
        if cleaned is None:
            return None
        return _densify_ring(_rdp_ring(cleaned, bnd_tol), spacing)

    for part in shapely.get_parts(material):
        shell = prep(part.exterior)
        if shell is None:
            continue
        holes = [h for interior in part.interiors if (h := prep(interior)) is not None]
        steiner = _interior_points(part, spacing, holdback=0.6)
        jobs.append((shell, holes, steiner))

    box: dict = {}

    def work():
        from pypoly2tri.cdt import CDT
        from pypoly2tri.shapes import Point as P2Point

        vmap: dict[tuple, int] = {}
        planar: list[tuple[float, float]] = []

        def vidx(x: float, y: float) -> int:
            key = (round(x * 1e6), round(y * 1e6))
            i = vmap.get(key)
            if i is None:
                i = len(planar)
                vmap[key] = i
                planar.append((x, y))
            return i

        tri_idx: list[tuple[int, int, int]] = []
        for shell, holes, steiner in jobs:
            cdt = CDT([P2Point(float(x), float(y)) for x, y in shell])
            for h in holes:
                cdt.AddHole([P2Point(float(x), float(y)) for x, y in h])
            for x, y in steiner:
                cdt.AddPoint(P2Point(float(x), float(y)))
            cdt.Triangulate()
            for tr in cdt.GetTriangles():
                if not tr.IsInterior():
                    continue
                p0, p1, p2 = tr.GetPoint(0), tr.GetPoint(1), tr.GetPoint(2)
                area2 = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)
                a = vidx(p0.x, p0.y)
                b = vidx(p1.x, p1.y)
                c = vidx(p2.x, p2.y)
                if area2 < 0.0:
                    b, c = c, b
                tri_idx.append((a, b, c))
        box["tri"] = tri_idx
        box["planar"] = planar

    _run_with_large_stack(work)
    if not box.get("tri"):
        raise ValueError(
            "constrained triangulation produced no triangles (material may be "
            "degenerate after cutting); check the SVG, design margin, or cut separation"
        )
    return box["tri"], box["planar"]


def _run_with_large_stack(fn) -> None:
    """Run ``fn`` on a worker thread with a large stack + high recursion limit.

    poly2tri's recursive edge legalisation can recurse thousands deep on a dense
    region; the default 8 MB C stack / 1000-frame Python limit overflow. We give
    the worker 512 MB of stack (virtual; only touched pages commit) and restore
    the interpreter state afterwards.
    """
    import sys
    import threading

    box: dict = {}

    def runner():
        old_limit = sys.getrecursionlimit()
        sys.setrecursionlimit(2_000_000)
        try:
            fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller thread
            box["exc"] = exc
        finally:
            sys.setrecursionlimit(old_limit)

    prev_size = threading.stack_size(512 * 1024 * 1024)
    try:
        t = threading.Thread(target=runner)
        t.start()
        t.join()
    finally:
        threading.stack_size(prev_size)
    if "exc" in box:
        raise box["exc"]


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


def _connected_components(faces: np.ndarray, n_vertices: int) -> np.ndarray:
    """Label each face by its connected component (faces sharing a vertex)."""
    parent = np.arange(n_vertices)

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for tri in faces:
        r0 = find(int(tri[0]))
        for w in tri[1:]:
            rw = find(int(w))
            if rw != r0:
                parent[rw] = r0
    return np.array([find(int(i)) for i in faces[:, 0]])


def _orient_outward(mesh: Mesh) -> None:
    """Flip each connected component whose faces wind net-inward.

    A shell with through-holes plus detached material islands is several
    disjoint closed surfaces.  A single global signed-volume test can leave a
    minority island inverted (its sign ridden over by the dominant shell), so
    orientation is decided per component.
    """
    v = mesh.vertices
    f = mesh.faces
    if len(f) == 0:
        return
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    tri_vol6 = np.einsum("ij,ij->i", a, np.cross(b, c))  # 6x signed volume per face
    comp = _connected_components(f, len(v))
    flip = np.zeros(len(f), dtype=bool)
    for cid in np.unique(comp):
        sel = comp == cid
        if tri_vol6[sel].sum() < 0.0:
            flip[sel] = True
    if flip.any():
        new = f.copy()
        new[flip] = new[flip][:, [0, 2, 1]]
        mesh.faces = new


def _assert_manifold(faces: np.ndarray) -> None:
    """Raise if the assembled shell has an edge shared by more than two faces.

    This happens when a cut hole touches the rim (or another hole) at a single
    vertex that survives pinch-splitting as one fan: the side walls then meet
    non-manifold there.  Fail loudly with the remedy instead of writing an
    unprintable stencil.
    """
    if len(faces) == 0:
        return
    directed = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    undirected = np.sort(directed, axis=1)
    _, counts = np.unique(undirected, axis=0, return_counts=True)
    n_bad = int(np.sum(counts > 2))
    if n_bad:
        raise ValueError(
            f"assembled shell has {n_bad} non-manifold edge(s); a cut hole "
            "likely touches the rim or another hole at a point. Increase "
            "cut_separation_svg (--... wider separation) to pull them apart."
        )


def _sphere_area(part, mapper: Mapper, cfg) -> float:
    """Approximate on-sphere area (mm^2) of a planar component.

    The Lambert areal scale grows toward the rim (~1/(1-u^2)), so evaluate it
    at the component's own centroid radius rather than a single mid-cap
    constant -- otherwise a real rim island is under-measured and dropped (and
    a near-pole speck over-measured and kept).
    """
    c = part.centroid
    rho = float(np.hypot(c.x - mapper.center[0], c.y - mapper.center[1]))
    return float(part.area * mapper.areal_scale(rho, cfg.outer_radius_mm))


def _drop_tiny(material, cfg, center, r_ref):
    if cfg.min_island_area_mm2 <= 0:
        return material
    parts = list(shapely.get_parts(material))
    mapper = build_mapper(center, r_ref, cfg.cap_angle_rad, cfg.flip_v)
    keep = [p for p in parts if _sphere_area(p, mapper, cfg) >= cfg.min_island_area_mm2]
    if not keep:
        raise ValueError(
            "every material component is below min_island_area_mm2 "
            f"({cfg.min_island_area_mm2} mm^2); nothing left to build -- lower "
            "--min-island or check the artwork scale"
        )
    if len(keep) == len(parts):
        return material
    return shapely.union_all(keep)


def _component_areas(material, mapper, cfg) -> list[float]:
    return sorted(
        (_sphere_area(p, mapper, cfg) for p in shapely.get_parts(material)),
        reverse=True,
    )


def _count_holes(material) -> int:
    n = 0
    for p in shapely.get_parts(material):
        n += len(p.interiors)
    return n

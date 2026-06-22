"""End-to-end pipeline: SVG -> stencil shell mesh -> STL/OBJ + report."""

from __future__ import annotations

import os
from dataclasses import dataclass, replace

import numpy as np

from .config import Config
from .svgio import load_artwork
from .meshbuild import build_shell
from .meshcheck import check_mesh, MeshReport
from .export import write_stl, write_obj
from .mapping import build_mapper


@dataclass
class PipelineResult:
    build: object
    report: MeshReport
    files: list[str]
    chord_error_mm: float


def _provisional_scale_max(region, center, cfg) -> float:
    import shapely
    xy = shapely.get_coordinates(region)
    d = np.hypot(xy[:, 0] - center[0], xy[:, 1] - center[1])
    r_ref = float(d.max()) * cfg.design_margin if cfg.design_reference_radius is None \
        else float(cfg.design_reference_radius)
    mapper = build_mapper(center, r_ref, cfg.cap_angle_rad, cfg.flip_v)
    return mapper.scale_bounds(cfg.outer_radius_mm)[2]


def run(cfg: Config | None = None, *, verbose: bool = True) -> PipelineResult:
    # Work on our own copy: run() locks design_reference_radius/centre when
    # --match is used, and that must not leak back onto the caller's Config
    # (which would silently override a later, different design's own extent).
    cfg = replace(cfg) if cfg is not None else Config()
    cfg.validate()
    log = print if verbose else (lambda *a, **k: None)

    # --- 1. load + tessellate (two passes to honour the chord-error budget) --
    provisional_tol = 0.2  # SVG units
    art = load_artwork(cfg.svg_path, provisional_tol, cfg.snap_grid_svg)

    # Lock scale + centre to a reference SVG so designs sharing a coordinate
    # system register identically on the sphere ("scale must match exactly").
    if cfg.match_svg:
        from .meshbuild import _region_max_radius
        ref = load_artwork(cfg.match_svg, provisional_tol, cfg.snap_grid_svg)
        ref_center = np.asarray(cfg.design_center_uv or ref.center, dtype=np.float64)
        cfg.design_reference_radius = _region_max_radius(ref.region, ref_center) * cfg.design_margin
        cfg.design_center_uv = tuple(ref_center)
        log(f"[match] scale/centre locked to {cfg.match_svg}: "
            f"R_ref={cfg.design_reference_radius:.3f}  centre=({ref_center[0]:.3f}, {ref_center[1]:.3f})")

    center = cfg.design_center_uv or art.center
    center = np.asarray(center, dtype=np.float64)

    scale_max = _provisional_scale_max(art.region, center, cfg)
    chord_tol_svg = cfg.chord_error_mm / scale_max
    if chord_tol_svg < provisional_tol:
        art = load_artwork(cfg.svg_path, chord_tol_svg, cfg.snap_grid_svg)
    chord_error_mm = chord_tol_svg * scale_max

    log(f"[svg]   labels={art.labels}  viewBox={art.viewbox}")
    log(f"[svg]   mapping centre = ({center[0]:.2f}, {center[1]:.2f})  "
        f"chord tol = {chord_tol_svg:.3f} svg units  (~{chord_error_mm:.3f} mm)")

    # --- 2. build the shell --------------------------------------------------
    build = build_shell(art.region, center, cfg)
    log(f"[map]   R_ref = {build.r_ref:.2f} svg units -> cap {cfg.cap_angle_deg:.0f} deg")
    log(f"[map]   inner R = {cfg.inner_radius_mm:.2f} mm  outer R = {cfg.outer_radius_mm:.2f} mm")
    log(f"[mesh]  planar verts = {build.mesh.n_planar}  spacing = {build.spacing_svg:.2f} svg units")
    log(f"[mesh]  cut holes = {build.n_cut_regions}  material components = {len(build.islands)}")
    if len(build.islands) > 1:
        smalls = ", ".join(f"{a:.1f}" for a in build.islands[1:])
        log(f"[warn]  {len(build.islands) - 1} disconnected island(s) "
            f"(areas mm^2: {smalls}) — these are free pieces in a real stencil")

    # --- 3. validate ---------------------------------------------------------
    report = check_mesh(build.mesh, cfg)
    log("[check]\n" + report.format(cfg))

    # --- 4. export -----------------------------------------------------------
    os.makedirs(cfg.out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(cfg.svg_path))[0]
    stl_path = os.path.join(cfg.out_dir, f"{base}_stencil.stl")
    obj_path = os.path.join(cfg.out_dir, f"{base}_stencil.obj")
    write_stl(stl_path, build.mesh.vertices, build.mesh.faces)
    write_obj(obj_path, build.mesh.vertices, build.mesh.faces)
    files = [stl_path, obj_path]

    # reference ball (for visual context / fit checking)
    ball_path = os.path.join(cfg.out_dir, "ball_reference.stl")
    bv, bf = _uv_sphere(cfg.ball_radius_mm, 96, 48)
    write_stl(ball_path, bv, bf)
    files.append(ball_path)

    for p in files:
        log(f"[out]   {p}  ({os.path.getsize(p)/1024:.0f} KB)")

    return PipelineResult(build=build, report=report, files=files,
                          chord_error_mm=chord_error_mm)


def _uv_sphere(radius: float, nu: int, nv: int):
    u = np.linspace(0, 2 * np.pi, nu, endpoint=False)
    v = np.linspace(0, np.pi, nv)
    uu, vv = np.meshgrid(u, v)
    x = radius * np.sin(vv) * np.cos(uu)
    y = radius * np.sin(vv) * np.sin(uu)
    z = radius * np.cos(vv)
    verts = np.column_stack([x.ravel(), y.ravel(), z.ravel()])
    faces = []
    for i in range(nv - 1):
        for j in range(nu):
            a = i * nu + j
            b = i * nu + (j + 1) % nu
            c = (i + 1) * nu + j
            d = (i + 1) * nu + (j + 1) % nu
            faces.append((a, c, b))
            faces.append((b, c, d))
    return verts.astype(np.float64), np.asarray(faces, dtype=np.int64)

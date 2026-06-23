"""Pin the cut-edge smoothness guarantee of the "constrained" mesher.

The product is the *cut edge* the user traces, so we measure how far the 3D mesh
boundary (every hole + the rim) deviates from the true tessellated design curve
on the sphere surface, and assert:

  1. the "constrained" mesher keeps that deviation within the boundary-smoothness
     budget (BOUNDARY_SMOOTHNESS_MM), and
  2. it is markedly smoother than the legacy "centroid" mesher (whose boundary is
     a by-product of the centroid test and faceted / sawtoothed).

Runnable standalone (``python tests/test_edge_smoothness.py``) or via pytest.
There is no other Python test runner wired up, so keep this dependency-free.
"""
from __future__ import annotations

import os
import sys
from dataclasses import replace

import numpy as np
import shapely
from shapely.geometry import Point

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ball_stencil.config import Config
from ball_stencil.svgio import load_artwork
from ball_stencil import meshbuild as MB
from ball_stencil.pipeline import _provisional_scale_max, run


def _true_curve_boundary(svg: str, cfg: Config, center, r_ref: float, scale_max: float):
    """The design cut boundary mapped to the outer sphere, at ~0 chord error."""
    truth = load_artwork(svg, 0.002 / scale_max, 0.0).region
    cut = shapely.make_valid(truth.buffer(cfg.cut_separation_svg, quad_segs=64))
    disc = Point(center[0], center[1]).buffer(r_ref, quad_segs=512)
    return shapely.make_valid(disc.difference(cut)).boundary


def _mesh_boundary_planar(build):
    """Recover the planar coordinates of the outer-surface boundary edges."""
    mp = build.mapper
    n = build.mesh.n_planar
    dirs = build.mesh.vertices[:n] / np.linalg.norm(build.mesh.vertices[:n], axis=1, keepdims=True)
    dz = np.clip(dirs[:, 2], -1.0, 1.0)
    phi = np.arccos(dz)
    theta = np.arctan2(dirs[:, 1], dirs[:, 0])
    rho = np.sin(phi / 2.0) / mp._sin_half_cap * mp.r_ref
    px = mp.center[0] + rho * np.cos(theta)
    py = mp.center[1] + (-rho * np.sin(theta) if mp.flip_v else rho * np.sin(theta))
    planar = np.column_stack([px, py])

    faces = build.mesh.faces
    outer = faces[(faces < n).all(axis=1)]
    edges = set()
    for a, b, c in outer:
        edges.update([(a, b), (b, c), (c, a)])
    bnd = [(a, b) for (a, b) in edges if (b, a) not in edges]
    return planar, bnd


def _max_boundary_deviation_mm(svg: str, strategy: str) -> float:
    cfg = Config(svg_path=svg)
    cfg.mesh_strategy = strategy
    art0 = load_artwork(svg, 0.2, 0.0)
    center = np.asarray(art0.center, dtype=np.float64)
    scale_max = _provisional_scale_max(art0.region, center, cfg)
    art = load_artwork(svg, cfg.boundary_smoothness_mm / scale_max, 0.0 if strategy == "constrained" else cfg.snap_grid_svg)
    build = MB.build_shell(art.region, center, cfg)
    scale_mid = build.mapper.scale_bounds(cfg.outer_radius_mm)[1]

    true_b = _true_curve_boundary(svg, cfg, center, build.r_ref, scale_max)
    planar, bnd = _mesh_boundary_planar(build)
    # sample each boundary edge (incl. midpoint) and measure distance to the
    # true curve, scaled to mm on the sphere.
    samples = []
    for a, b in bnd:
        pa, pb = planar[a], planar[b]
        for t in (0.0, 0.5):
            samples.append(pa * (1 - t) + pb * t)
    dev = shapely.distance(shapely.points(np.asarray(samples)), true_b) * scale_mid
    return float(dev.max())


def test_constrained_cut_edge_is_smooth_and_beats_centroid():
    budget = Config().boundary_smoothness_mm
    for svg in ("splash.svg", "splash_z.svg"):
        constrained = _max_boundary_deviation_mm(svg, "constrained")
        centroid = _max_boundary_deviation_mm(svg, "centroid")
        print(f"{svg}: constrained max dev = {constrained:.4f} mm, "
              f"centroid max dev = {centroid:.4f} mm, budget = {budget} mm")
        # 1. constrained edge stays within the boundary-smoothness budget (+10% slack)
        assert constrained <= budget * 1.1, (
            f"{svg}: constrained cut edge deviates {constrained:.4f} mm > budget {budget} mm")
        # 2. constrained is meaningfully smoother than the legacy centroid mesher
        assert constrained < centroid, (
            f"{svg}: constrained ({constrained:.4f}) not smoother than centroid ({centroid:.4f})")


def test_both_strategies_pass_meshcheck():
    for svg in ("splash.svg", "splash_z.svg"):
        for strategy in ("constrained", "centroid"):
            cfg = Config(svg_path=svg, out_dir="out", mesh_strategy=strategy)
            res = run(replace(cfg), verbose=False)
            assert res.report.ok(cfg), f"{svg} {strategy} failed meshcheck"
            assert res.report.is_watertight and res.report.is_manifold
            assert res.report.n_degenerate == 0


if __name__ == "__main__":
    test_constrained_cut_edge_is_smooth_and_beats_centroid()
    test_both_strategies_pass_meshcheck()
    print("OK: edge-smoothness guarantees hold")

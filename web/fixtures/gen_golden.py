"""Run the Python oracle over a config matrix and emit golden JSON.

Run from repo root:  uv run python web/fixtures/gen_golden.py
Writes web/fixtures/golden.json (one source of truth for both test layers).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.getcwd())

from ball_stencil.config import Config
from ball_stencil.pipeline import run

SVG_DIR = os.path.join("web", "fixtures", "svg")


def metrics(svg: str, **overrides) -> dict:
    cfg = Config(svg_path=os.path.join(SVG_DIR, svg), out_dir="out")
    for k, v in overrides.items():
        setattr(cfg, k, v)
    res = run(cfg, verbose=False)
    b, r = res.build, res.report
    islands = [round(a, 4) for a in b.islands]
    return {
        "svg": svg,
        "overrides": overrides,
        "r_ref": round(b.r_ref, 6),
        "inner_radius_mm": round(cfg.inner_radius_mm, 6),
        "outer_radius_mm": round(cfg.outer_radius_mm, 6),
        "center": [round(float(b.center[0]), 6), round(float(b.center[1]), 6)],
        "chord_error_mm": round(res.chord_error_mm, 6),
        "spacing_svg": round(b.spacing_svg, 6),
        "n_cut_regions": b.n_cut_regions,
        "n_components": len(b.islands),
        "islands_mm2": islands,
        "n_vertices": r.n_vertices,
        "n_faces": r.n_faces,
        "n_planar": b.mesh.n_planar,
        "is_watertight": r.is_watertight,
        "is_manifold": r.is_manifold,
        "consistent_winding": r.consistent_winding,
        "n_boundary_edges": r.n_boundary_edges,
        "n_nonmanifold_edges": r.n_nonmanifold_edges,
        "max_radius_error_mm": r.max_radius_error_mm,
        "edge_len_min": round(r.edge_len_min, 6),
        "edge_len_mean": round(r.edge_len_mean, 6),
        "edge_len_max": round(r.edge_len_max, 6),
        "max_aspect_ratio": round(r.max_aspect_ratio, 6),
        "signed_volume_mm3": round(r.signed_volume_mm3, 4),
        "n_degenerate": r.n_degenerate,
        "ok": r.ok(cfg),
    }


def err_case(svg: str, **overrides) -> dict:
    cfg = Config(svg_path=os.path.join(SVG_DIR, svg), out_dir="out")
    for k, v in overrides.items():
        setattr(cfg, k, v)
    try:
        run(cfg, verbose=False)
        return {"svg": svg, "overrides": overrides, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"svg": svg, "overrides": overrides, "error": str(e)}


def main() -> None:
    cases = []
    matrix = [
        ("splash.svg", {}),
        ("splash.svg", {"wall_thickness_mm": 4.0}),
        ("splash.svg", {"cap_angle_deg": 60.0}),
        ("splash.svg", {"target_edge_mm": 2.5}),
        ("splash.svg", {"sphere_diameter_mm": 180.0}),
        ("splash_z.svg", {}),
        ("dot.svg", {}),
        ("dot.svg", {"wall_thickness_mm": 4.0}),
        ("dot.svg", {"cap_angle_deg": 60.0}),
        ("dot.svg", {"target_edge_mm": 2.5}),
        ("dot.svg", {"sphere_diameter_mm": 180.0}),
        ("dot.svg", {"fit_clearance_mm": 1.0}),
        ("ring.svg", {}),
        ("ring.svg", {"min_island_area_mm2": 0.0}),
        ("ring.svg", {"wall_thickness_mm": 4.0}),
        ("multi.svg", {}),
        ("multi.svg", {"cap_angle_deg": 60.0}),
    ]
    for svg, ov in matrix:
        print(f"[golden] {svg} {ov}", file=sys.stderr)
        cases.append(metrics(svg, **ov))

    errors = [
        err_case("dot.svg", cap_angle_deg=0.0),
        err_case("dot.svg", cap_angle_deg=180.0),
        err_case("dot.svg", wall_thickness_mm=-1.0),
        err_case("dot.svg", cut_separation_svg=100.0),
        err_case("dot.svg", design_margin=0.2),
    ]

    out = {"cases": cases, "errors": errors}
    path = os.path.join("web", "fixtures", "golden.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"wrote {path}", file=sys.stderr)


if __name__ == "__main__":
    main()

"""CLI entry point: python -m ball_stencil [svg] [options]."""

from __future__ import annotations

import argparse
import sys

from .config import Config
from .pipeline import run


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="ball_stencil", description=__doc__)
    p.add_argument("svg", nargs="?", default="splash.svg", help="input SVG path")
    p.add_argument("-o", "--out-dir", default="out", help="output directory")
    p.add_argument("--diameter", type=float, help="ball diameter (mm)")
    p.add_argument("--clearance", type=float, help="fit clearance (mm)")
    p.add_argument("--wall", type=float, help="wall thickness (mm)")
    p.add_argument("--cap-angle", type=float, help="dome cap angle (deg)")
    p.add_argument("--target-edge", type=float, help="target triangle edge (mm)")
    p.add_argument("--margin", type=float, help="design margin factor (>1)")
    p.add_argument("--r-ref", type=float, help="override design reference radius (svg units)")
    p.add_argument("--match", help="lock scale+centre to this reference SVG (exact registration)")
    p.add_argument("--min-island", type=float, help="drop islands below this area (mm^2)")
    args = p.parse_args(argv)

    cfg = Config(svg_path=args.svg, out_dir=args.out_dir)
    if args.diameter is not None:
        cfg.sphere_diameter_mm = args.diameter
    if args.clearance is not None:
        cfg.fit_clearance_mm = args.clearance
    if args.wall is not None:
        cfg.wall_thickness_mm = args.wall
    if args.cap_angle is not None:
        cfg.cap_angle_deg = args.cap_angle
    if args.target_edge is not None:
        cfg.target_edge_mm = args.target_edge
    if args.margin is not None:
        cfg.design_margin = args.margin
    if args.r_ref is not None:
        cfg.design_reference_radius = args.r_ref
    if args.match is not None:
        cfg.match_svg = args.match
    if args.min_island is not None:
        cfg.min_island_area_mm2 = args.min_island

    result = run(cfg)
    return 0 if result.report.ok(cfg) else 1


if __name__ == "__main__":
    sys.exit(main())

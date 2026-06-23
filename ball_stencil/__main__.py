"""CLI entry point: python -m ball_stencil [svg|raster] [options].

The positional input is normally a filled SVG. A raster image (.png/.jpg/.jpeg/
.webp/.bmp/.gif) is detected by extension (or forced with --trace) and traced to
a filled-silhouette SVG first — written next to the outputs as ``<name>_traced.svg``
and fed to the *unchanged* pipeline via ``cfg.svg_path``. Tracing is an input
adapter only (see ball_stencil/raster.py)."""

from __future__ import annotations

import argparse
import os
import sys

from .config import Config
from .pipeline import run

# Raster extensions decodable by Pillow (mirrors the web RASTER_RE).
RASTER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="ball_stencil", description=__doc__)
    p.add_argument("svg", nargs="?", default="splash.svg", help="input SVG or raster image path")
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
    # Raster → silhouette SVG tracing (input adapter). Same option names/defaults
    # as the web port (backend/threshold/invert/detail).
    p.add_argument("--trace", action="store_true",
                   help="force tracing the input as a raster (otherwise detected by extension)")
    p.add_argument("--trace-backend", choices=("potrace", "color"), default="potrace",
                   help="raster tracer: potrace (clean silhouette) or color (photos)")
    p.add_argument("--trace-threshold", type=int, default=128,
                   help="raster bilevel cutoff 0-255 (default 128)")
    p.add_argument("--trace-invert", action="store_true",
                   help="trace light-on-dark instead of dark-on-light")
    p.add_argument("--trace-detail", type=int, default=2,
                   help="raster despeckle (potrace turdsize / vtracer filter_speckle)")
    args = p.parse_args(argv)

    svg_path = args.svg
    if args.trace or svg_path.lower().endswith(RASTER_EXTS):
        svg_path = _trace_raster(args)

    cfg = Config(svg_path=svg_path, out_dir=args.out_dir)
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


def _trace_raster(args) -> str:
    """Trace the raster input to ``<out_dir>/<name>_traced.svg`` and return its path.

    Writing an inspectable SVG keeps a single code path through the pipeline and
    leaves an artifact for debugging a bad trace (and a parity check vs the web
    preview), exactly as the spec asks.
    """
    from .raster import raster_to_svg, TraceOptions

    res = raster_to_svg(args.svg, TraceOptions(
        backend=args.trace_backend,
        threshold=args.trace_threshold,
        invert=args.trace_invert,
        detail=args.trace_detail,
    ))
    os.makedirs(args.out_dir, exist_ok=True)
    traced_path = os.path.join(args.out_dir, f"{res.name}_traced.svg")
    with open(traced_path, "w") as f:
        f.write(res.svg_text)
    print(f"[trace] {args.svg} -> {traced_path}  (backend={args.trace_backend})")
    return traced_path


if __name__ == "__main__":
    sys.exit(main())

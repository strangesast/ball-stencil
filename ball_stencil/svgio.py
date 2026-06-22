"""SVG loading and filled-region extraction.

The artwork is *filled* vector shapes (not strokes): each <path> carries many
closed subpaths that together describe a filled silhouette under the even-odd
rule.  We tessellate every subpath and fold them with symmetric-difference to
obtain the exact even-odd filled region as a shapely (Multi)Polygon.

This region is what becomes the *holes* in the stencil shell.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import Polygon
from svgpathtools import svg2paths2

from .tessellate import dedupe_polyline, flatten_path


@dataclass
class Artwork:
    region: shapely.Geometry       # even-odd filled region (Multi)Polygon, SVG units
    viewbox: tuple[float, float, float, float]  # (minx, miny, w, h)
    center: tuple[float, float]    # default mapping centre (viewBox centre)
    labels: list[str]              # path labels, for reference


def _parse_viewbox(svg_attr: dict) -> tuple[float, float, float, float]:
    vb = svg_attr.get("viewBox") or svg_attr.get("viewbox")
    if vb:
        a = [float(x) for x in vb.replace(",", " ").split()]
        return (a[0], a[1], a[2], a[3])
    # fall back to width/height in user units
    w = float(str(svg_attr.get("width", "0")).rstrip("pt").rstrip("px") or 0)
    h = float(str(svg_attr.get("height", "0")).rstrip("pt").rstrip("px") or 0)
    return (0.0, 0.0, w, h)


def load_artwork(svg_path: str, chord_tol_svg: float, snap_grid: float = 0.0) -> Artwork:
    """Load filled paths from ``svg_path`` and return the even-odd region.

    ``chord_tol_svg`` is the Bezier flattening tolerance in SVG user units.
    ``snap_grid`` (>0) grid-snaps the region to clean topology and drop slivers.
    Only <path> elements with a visible fill are used; <image> tags and
    display:none paths are ignored.
    """
    paths, attrs, svg_attr = svg2paths2(svg_path)
    viewbox = _parse_viewbox(svg_attr)

    ring_polys: list[Polygon] = []
    labels: list[str] = []
    for path, attr in zip(paths, attrs):
        style = (attr.get("style") or "")
        if "display:none" in style.replace(" ", "") or attr.get("display") == "none":
            continue
        labels.append(attr.get("inkscape:label") or attr.get("id") or "path")
        for sub in path.continuous_subpaths():
            poly = _subpath_to_polygon(sub, chord_tol_svg)
            if poly is not None:
                ring_polys.append(poly)

    if not ring_polys:
        raise ValueError(f"No filled vector paths found in {svg_path}")

    # Even-odd fill == XOR of every ring interior.
    region = ring_polys[0]
    for poly in ring_polys[1:]:
        region = shapely.symmetric_difference(region, poly)
    region = shapely.make_valid(region)
    if snap_grid > 0:
        region = shapely.make_valid(shapely.set_precision(region, snap_grid))

    minx, miny, w, h = viewbox
    center = (minx + w / 2.0, miny + h / 2.0)
    return Artwork(region=region, viewbox=viewbox, center=center, labels=labels)


def _subpath_to_polygon(sub, chord_tol_svg: float) -> Polygon | None:
    pts = dedupe_polyline(flatten_path(sub, chord_tol_svg))
    if len(pts) < 3:
        return None
    # close the ring
    if np.any(np.abs(pts[0] - pts[-1]) > 1e-9):
        pts = np.vstack([pts, pts[0]])
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.area <= 0:
        return None
    return poly

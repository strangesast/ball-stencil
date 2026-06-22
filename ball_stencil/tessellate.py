"""Adaptive Bezier/segment tessellation.

Converts svgpathtools segments (Line / Quadratic / Cubic / Arc) into polylines
by recursive subdivision until the chord deviation falls below a tolerance,
expressed in SVG user units.  Tolerance is provided by the caller, derived from
the manufacturing chord-error budget and the plane->sphere scale.
"""

from __future__ import annotations

import numpy as np


def _flatten_segment(seg, tol: float, depth: int, max_depth: int, out: list) -> None:
    """Append intermediate points of ``seg`` (excluding its start) to ``out``."""
    p0 = seg.point(0.0)
    p1 = seg.point(1.0)
    pm = seg.point(0.5)

    # Distance of the true midpoint from the chord p0->p1.
    chord = p1 - p0
    clen = abs(chord)
    if clen <= 1e-12:
        dev = abs(pm - p0)
    else:
        # perpendicular distance from pm to the chord line
        dev = abs((pm - p0).real * (-chord.imag) + (pm - p0).imag * chord.real) / clen

    if dev <= tol or depth >= max_depth:
        out.append((p1.real, p1.imag))
        return

    left, right = seg.split(0.5) if hasattr(seg, "split") else _split_via_curve(seg)
    _flatten_segment(left, tol, depth + 1, max_depth, out)
    _flatten_segment(right, tol, depth + 1, max_depth, out)


def _split_via_curve(seg):
    # svgpathtools segments all implement .split via cropping; fallback only.
    from svgpathtools import Line
    mid = seg.point(0.5)
    return (Line(seg.point(0.0), mid), Line(mid, seg.point(1.0)))


def flatten_path(path, tol: float, max_depth: int = 18) -> list[tuple[float, float]]:
    """Flatten one svgpathtools Path (a single continuous subpath) to a polyline.

    Returns a list of (x, y) points including both endpoints, in order.
    """
    pts: list[tuple[float, float]] = []
    if len(path) == 0:
        return pts
    start = path[0].point(0.0)
    pts.append((start.real, start.imag))
    for seg in path:
        _flatten_segment(seg, tol, 0, max_depth, pts)
    return pts


def dedupe_polyline(points: list[tuple[float, float]], eps: float = 1e-9) -> np.ndarray:
    """Remove consecutive duplicate points; return (N,2) float64 array."""
    if not points:
        return np.zeros((0, 2), dtype=np.float64)
    arr = np.asarray(points, dtype=np.float64)
    keep = np.ones(len(arr), dtype=bool)
    keep[1:] = np.any(np.abs(np.diff(arr, axis=0)) > eps, axis=1)
    return arr[keep]

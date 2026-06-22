"""Central configuration for the ball-stencil pipeline.

Every physical / geometric parameter lives here as a named constant so the
output scales from these values only (per spec requirement). All lengths are
in millimetres and all computation downstream is float64.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import radians

import numpy as np

# ----------------------------------------------------------------------------
# Sphere / ball definition  (the stencil is fitted over this ball)
# ----------------------------------------------------------------------------
SPHERE_DIAMETER_MM = 206.0                       # regulation volleyball, configurable
BALL_RADIUS_MM = SPHERE_DIAMETER_MM / 2.0        # 103.0

# ----------------------------------------------------------------------------
# Stencil shell (the thing we actually manufacture)
# ----------------------------------------------------------------------------
# The stencil is a thickened hemispherical shell that slips over the ball.
# Its inner surface sits at BALL_RADIUS + clearance; the wall extends outward.
FIT_CLEARANCE_MM = 0.4          # gap between ball and stencil inner wall (slip fit)
WALL_THICKNESS_MM = 2.0         # radial wall thickness of the shell

INNER_RADIUS_MM = BALL_RADIUS_MM + FIT_CLEARANCE_MM     # 103.4
OUTER_RADIUS_MM = INNER_RADIUS_MM + WALL_THICKNESS_MM   # 105.4

# How far down the ball the dome reaches, measured as polar angle from the pole.
# 90 deg == full hemisphere (rim at the equator).
CAP_ANGLE_DEG = 90.0

# ----------------------------------------------------------------------------
# Design placement on the dome
# ----------------------------------------------------------------------------
# Mapping family. Only "lambert" (azimuthal equal-area) is wired up; the other
# names document the alternatives discussed.
MAPPING = "lambert"             # lambert | equidistant | stereographic

# Centre of the SVG that maps to the dome pole. None -> use viewBox centre.
DESIGN_CENTER_UV = None         # (x, y) in SVG user units, or None

# Reference radius (SVG units) that maps to CAP_ANGLE_DEG. None -> derived from
# the artwork extent times DESIGN_MARGIN (leaves a material frame around it).
DESIGN_REFERENCE_RADIUS = None
DESIGN_MARGIN = 1.06            # rim sits this factor beyond the outermost artwork

# Match the scale + centre of another SVG so designs that share a coordinate
# system register identically on the sphere. None -> use this file's own extent.
# When set, R_ref and centre are taken from the reference file, NOT this one.
MATCH_SVG = None

# SVG y axis points down. Flip so the design is not mirrored when the dome is
# viewed from outside looking at the pole.
FLIP_V = True

# ----------------------------------------------------------------------------
# Curve tessellation (Bezier -> polyline)
# ----------------------------------------------------------------------------
CHORD_ERROR_MM = 0.10           # max chord deviation on the sphere surface
MIN_SEGMENT_MM = 0.05           # smallest arc-length segment we bother emitting

# ----------------------------------------------------------------------------
# Surface meshing
# ----------------------------------------------------------------------------
TARGET_EDGE_MM = 1.2            # nominal triangle edge length on the sphere
MAX_EDGE_MM = 1.5               # quality target / reporting threshold

# ----------------------------------------------------------------------------
# Numerical
# ----------------------------------------------------------------------------
DTYPE = np.float64
RADIUS_TOLERANCE_MM = 0.01      # |‖P‖ - R| must stay under this

# Topology cleanup grid (SVG user units). Coordinates are snapped to this grid
# to merge near-coincident boundaries, remove sub-grid slivers, and guarantee a
# clean manifold. Kept far below the chord-error budget.
SNAP_GRID_SVG = 0.05

# Cut-hole dilation (SVG user units). Holes are grown by this amount before the
# material is subtracted. This separates/merges boundaries that meet at a single
# point (which would otherwise pinch the shell into a non-manifold) and removes
# unprintably-thin webbing between adjacent splashes.
CUT_SEPARATION_SVG = 0.30

# Drop disconnected material islands smaller than this surface area (mm^2).
# Such islands (e.g. the enclosed hole inside splash_2) would fall out of a real
# stencil. The default removes XOR noise specks while keeping (and warning about)
# genuinely large free islands. Set 0 to keep everything.
MIN_ISLAND_AREA_MM2 = 1.0


@dataclass
class Config:
    """Runtime bundle; defaults pull from the module-level constants."""

    svg_path: str = "splash.svg"
    out_dir: str = "out"

    sphere_diameter_mm: float = SPHERE_DIAMETER_MM
    fit_clearance_mm: float = FIT_CLEARANCE_MM
    wall_thickness_mm: float = WALL_THICKNESS_MM
    cap_angle_deg: float = CAP_ANGLE_DEG

    mapping: str = MAPPING
    design_center_uv: tuple[float, float] | None = DESIGN_CENTER_UV
    design_reference_radius: float | None = DESIGN_REFERENCE_RADIUS
    design_margin: float = DESIGN_MARGIN
    match_svg: str | None = MATCH_SVG
    flip_v: bool = FLIP_V

    chord_error_mm: float = CHORD_ERROR_MM
    min_segment_mm: float = MIN_SEGMENT_MM
    target_edge_mm: float = TARGET_EDGE_MM
    max_edge_mm: float = MAX_EDGE_MM

    radius_tolerance_mm: float = RADIUS_TOLERANCE_MM
    min_island_area_mm2: float = MIN_ISLAND_AREA_MM2
    snap_grid_svg: float = SNAP_GRID_SVG
    cut_separation_svg: float = CUT_SEPARATION_SVG

    @property
    def ball_radius_mm(self) -> float:
        return self.sphere_diameter_mm / 2.0

    @property
    def inner_radius_mm(self) -> float:
        return self.ball_radius_mm + self.fit_clearance_mm

    @property
    def outer_radius_mm(self) -> float:
        return self.inner_radius_mm + self.wall_thickness_mm

    @property
    def cap_angle_rad(self) -> float:
        return radians(self.cap_angle_deg)
